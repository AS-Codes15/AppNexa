import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import type { Message, FileData } from "@/types/workspace";
import { protectAIRequest } from "@/lib/arcjet";
import { isMessage, isRecord, parseFileData } from "@/lib/workspace-data";

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

// ─── Extract short label from a Gemini thought chunk ─────────────────────────
// Gemini thoughts often start with a bold heading like **Verify Config**
// We extract that. If no bold heading, take the first sentence only.

function extractThoughtLabel(text: string): string | null {
  // Try to grab **bold heading** at the start
  const boldMatch = text.match(/\*\*([^*]{4,60})\*\*/);
  if (boldMatch) return boldMatch[1].trim();

  // Fall back to first sentence (up to first . or \n), capped at 60 chars
  const sentence = text.split(/[.\n]/)[0].trim();
  if (sentence.length >= 8 && sentence.length <= 80) return sentence;

  return null;
}

// ─── npm validation ───────────────────────────────────────────────────────────

async function validateDependencies(
  deps: Record<string, string>
): Promise<Record<string, string>> {
  const valid: Record<string, string> = {};
  await Promise.all(
    Object.entries(deps).map(async ([pkg, version]) => {
      const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status === 404) return;
      if (!res.ok) {
        throw new Error(`Could not validate npm package "${pkg}" (${res.status}).`);
      }
      valid[pkg] = version;
    })
  );
  return valid;
}

// ─── History trimming ─────────────────────────────────────────────────────────

function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= 10) return messages;
  return [messages[0], ...messages.slice(-8)];
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert React developer. Your job is to generate complete, working React applications based on user prompts.

RULES:
1. Always respond with a valid JSON object — no markdown fences, no extra text.
2. The JSON must match this exact shape:
{
  "assistantMessage": "<brief explanation of what you built/changed>",
  "title": "<short 2-4 word title for the app, e.g. 'Todo List App'>",
  "files": {
    "/App.js": { "code": "<full file content>" },
    "/components/SomeComponent.js": { "code": "<full file content>" }
  },
  "dependencies": {
    "some-package": "latest"
  }
}
3. Use React (functional components + hooks). Do NOT use TypeScript in generated files.
4. Use Tailwind CSS for all styling. Do not use CSS modules or inline styles unless absolutely necessary.
5. The entry point must always be /App.js and must export a default component.
6. All imports must reference files you include in "files" or packages in "dependencies".
7. Do not include react, react-dom, or tailwindcss in "dependencies" — they are always available.
8. When modifying existing code, include ALL files (both changed and unchanged) in "files".
9. Keep code clean, readable, and production-quality.
10. If the user attaches an image, use it as a design reference and match the layout/style as closely as possible.`;

// ─── Gemini contents builder ──────────────────────────────────────────────────

function buildContents(messages: Message[], fileData: FileData | null) {
  const trimmed = trimHistory(messages);

  return trimmed.map((msg, idx) => {
    const role = msg.role === "assistant" ? "model" : "user";

    if (msg.role === "user") {
      const parts: object[] = [];

      let text = msg.content;

      if (msg.imageUrl) {
        text = `[The user has attached an image. Use this URL directly in the generated app where relevant (as img src, background-image, etc.): ${msg.imageUrl}]\n\n${text}`;
      }

      const isLast = idx === trimmed.length - 1;
      if (isLast && fileData) {
        text +=
          "\n\nCurrent project files for context:\n" +
          JSON.stringify(fileData, null, 2);
      }

      parts.push({ text });
      return { role, parts };
    }

    return { role, parts: [{ text: msg.content }] };
  });
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Invalid JSON request body" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return Response.json({ message: "Invalid request body" }, { status: 400 });
  }

  const userId = body.userId;
  const workspaceId = body.workspaceId;
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const fileData =
    body.fileData === null ? null : parseFileData(body.fileData);

  if (
    typeof userId !== "string" ||
    (workspaceId !== null && typeof workspaceId !== "string") ||
    !messages ||
    messages.length === 0 ||
    !messages.every(isMessage) ||
    (body.fileData !== null && !fileData)
  ) {
    return Response.json({ message: "Invalid generation request" }, { status: 400 });
  }

  const validMessages = messages as Message[];
  const lastUserMessage = [...validMessages]
    .reverse()
    .find((message) => message.role === "user");
  if (!lastUserMessage) {
    return Response.json({ message: "A user prompt is required" }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { message: "Server configuration is missing GEMINI_API_KEY" },
      { status: 503 }
    );
  }

  const protectionResponse = await protectAIRequest(
    request,
    clerkId,
    lastUserMessage.content
  );
  if (protectionResponse) return protectionResponse;

  const user = await db.user.findUnique({
    where: { id: userId, clerkId },
    select: { id: true, credits: true },
  });

  if (!user)
    return Response.json({ message: "User not found" }, { status: 404 });
  if (user.credits < CREDIT_COST_PER_GENERATION) {
    return Response.json({ message: "Insufficient credits" }, { status: 402 });
  }

  const encoder = new TextEncoder();
  const ai = new GoogleGenAI({ apiKey });

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) =>
        controller.enqueue(encoder.encode(chunk));

      try {
        const contents = buildContents(validMessages, fileData);

        const geminiStream = await ai.models.generateContentStream({
          model: "gemini-3.5-flash",
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0.7,
            responseMimeType: "application/json",
            thinkingConfig: {
              includeThoughts: true,
            },
          },
        });

        let accumulated = ""; // final JSON output
        let lastEmitTime = 0; // throttle thought emissions

        for await (const chunk of geminiStream) {
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];

          for (const part of parts) {
            if (!part.text) continue;

            if (part.thought) {
              // Extract just the short label — not the full wall of text
              const now = Date.now();
              if (now - lastEmitTime > 600) {
                const label = extractThoughtLabel(part.text);
                if (label) {
                  enqueue(sseEvent("status", { message: label }));
                  lastEmitTime = now;
                }
              }
            } else {
              // Actual JSON output
              accumulated += part.text;
            }
          }
        }

        // ── Parse the complete JSON response ──────────────────────────────────

        let parsed: unknown;

        try {
          parsed = JSON.parse(accumulated);
        } catch {
          enqueue(
            sseEvent("error", {
              message: "AI returned invalid JSON. Please try again.",
            })
          );
          controller.close();
          return;
        }

        if (
          !isRecord(parsed) ||
          typeof parsed.assistantMessage !== "string" ||
          !isRecord(parsed.files) ||
          !isRecord(parsed.dependencies)
        ) {
          enqueue(
            sseEvent("error", {
              message: "AI response has an invalid shape. Please try again.",
            })
          );
          controller.close();
          return;
        }

        const assistantMessage = parsed.assistantMessage;
        const aiTitle =
          typeof parsed.title === "string" ? parsed.title : undefined;
        const files: FileData["files"] = {};
        for (const [path, file] of Object.entries(parsed.files)) {
          if (!isRecord(file) || typeof file.code !== "string") {
            enqueue(
              sseEvent("error", {
                message: "AI response contains an invalid file. Please try again.",
              })
            );
            controller.close();
            return;
          }
          files[path] = { code: file.code };
        }

        const dependencies: Record<string, string> = {};
        for (const [name, version] of Object.entries(parsed.dependencies)) {
          if (typeof version !== "string") {
            enqueue(
              sseEvent("error", {
                message:
                  "AI response contains an invalid dependency. Please try again.",
              })
            );
            controller.close();
            return;
          }
          dependencies[name] = version;
        }

        if (Object.keys(files).length === 0 || !files["/App.js"]) {
          enqueue(
            sseEvent("error", {
              message: "AI response is missing /App.js. Please try again.",
            })
          );
          controller.close();
          return;
        }

        // ── Validate npm packages ──────────────────────────────────────────────

        enqueue(sseEvent("status", { message: "Validating packages…" }));
        const validatedDeps = await validateDependencies(dependencies ?? {});
        const newFileData: FileData = {
          files,
          dependencies: validatedDeps,
          title: aiTitle,
        };

        // ── Upsert workspace + deduct credit (single transaction) ──────────────

        enqueue(sseEvent("status", { message: "Saving…" }));

        const lastUserMessage = validMessages[validMessages.length - 1];
        const updatedMessages: Message[] = [
          ...validMessages,
          { role: "assistant", content: assistantMessage },
        ];

        const workspace = await db.$transaction(async (transaction) => {
          const debit = await transaction.user.updateMany({
            where: {
              id: user.id,
              credits: { gte: CREDIT_COST_PER_GENERATION },
            },
            data: { credits: { decrement: CREDIT_COST_PER_GENERATION } },
          });
          if (debit.count === 0) {
            throw new Error("Insufficient credits");
          }

          return workspaceId
            ? transaction.workspace.update({
                where: { id: workspaceId, userId: user.id },
                data: {
                  messages: updatedMessages as never,
                  fileData: newFileData as never,
                },
              })
            : transaction.workspace.create({
                data: {
                  userId: user.id,
                  title: aiTitle ?? lastUserMessage.content.slice(0, 80),
                  messages: updatedMessages as never,
                  fileData: newFileData as never,
                },
              });
        });

        const updatedUser = await db.user.findUnique({
          where: { id: userId },
          select: { credits: true },
        });

        // ── Emit final result ──────────────────────────────────────────────────

        enqueue(
          sseEvent("done", {
            workspaceId: workspace.id,
            assistantMessage,
            fileData: newFileData,
            creditsRemaining:
              updatedUser?.credits ?? user.credits - CREDIT_COST_PER_GENERATION,
          })
        );
      } catch (err) {
        console.error("[gen-ai-code] stream error:", err);
        enqueue(
          sseEvent("error", {
            message:
              err instanceof Error
                ? err.message
                : "Something went wrong. Please try again.",
          })
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export const runtime = "nodejs";
export const maxDuration = 300; // for vercel - 300s on Fluid
