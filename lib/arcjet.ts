import arcjet, {
  shield,
  tokenBucket,
  detectPromptInjection,
} from "@arcjet/next";

// Route-level Arcjet client for /api/gen-ai-code only.
// shield + detectBot handled globally in proxy.ts,
// Characteristics: "userId" means each Clerk user gets their own token bucket,
// so corporate offices / VPNs sharing an IP don't share rate limits.

export const aj = process.env.ARCJET_KEY
  ? arcjet({
      key: process.env.ARCJET_KEY,
      characteristics: ["userId"],
      rules: [
        shield({ mode: "LIVE" }),
        tokenBucket({
          mode: "LIVE",
          refillRate: 5,
          interval: 60,
          capacity: 5,
        }),
        detectPromptInjection({ mode: "LIVE" }),
      ],
    })
  : null;

export async function protectAIRequest(
  request: Request,
  userId: string,
  prompt: string
): Promise<Response | null> {
  if (!aj) {
    if (process.env.NODE_ENV === "production") {
      return Response.json(
        { message: "Server configuration is missing ARCJET_KEY" },
        { status: 503 }
      );
    }
    return null;
  }

  const decision = await aj.protect(request, {
    requested: 1,
    userId,
    detectPromptInjectionMessage: prompt,
  });

  if (decision.isDenied()) {
    const isRateLimited = decision.reason.isRateLimit();
    const isPromptInjection = decision.reason.isPromptInjection();
    return Response.json(
      {
        message: isRateLimited
          ? "Too many requests. Please slow down."
          : isPromptInjection
            ? "Prompt injection detected. Please rephrase your request."
            : "Request blocked",
      },
      { status: isRateLimited ? 429 : isPromptInjection ? 400 : 403 }
    );
  }

  if (decision.isErrored()) {
    console.error("[arcjet] Request protection failed:", decision.reason);
  }

  return null;
}
