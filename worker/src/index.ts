interface Env {
  OPENAI_API_KEY: string;
  ALLOWED_FIREBASE_UIDS: string;
  FIREBASE_API_KEY: string;
}

type CoachRequest = {
  message: string;
  today: string;
  selectedDate: string;
  goals: { calories: number; protein: number };
  entries: Array<{ date: string; calories?: number; protein?: number; weight?: number; notes?: string }>;
  mealLogs: Array<{ date: string; summary: string; calories: number; protein: number }>;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
};

type CoachResult = {
  reply: string;
  proposals: Array<{
    type: "meal" | "weight" | "goals";
    date: string | null;
    summary: string;
    calories: number | null;
    protein: number | null;
    weight: number | null;
    calorieTarget: number | null;
    proteinTarget: number | null;
    uncertainty: string;
  }>;
};

const ALLOWED_ORIGINS = new Set([
  "https://ninetalesgames.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "proposals"],
  properties: {
    reply: { type: "string" },
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "date", "summary", "calories", "protein", "weight", "calorieTarget", "proteinTarget", "uncertainty"],
        properties: {
          type: { type: "string", enum: ["meal", "weight", "goals"] },
          date: { type: ["string", "null"] },
          summary: { type: "string" },
          calories: { type: ["integer", "null"] },
          protein: { type: ["integer", "null"] },
          weight: { type: ["number", "null"] },
          calorieTarget: { type: ["integer", "null"] },
          proteinTarget: { type: ["integer", "null"] },
          uncertainty: { type: "string" },
        },
      },
    },
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const cors = getCorsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST" || new URL(request.url).pathname !== "/coach") {
      return json({ error: "Not found" }, 404, cors);
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    try {
      const uid = await verifyFirebaseUser(request, env);
      const allowedUids = env.ALLOWED_FIREBASE_UIDS.split(",").map((value) => value.trim());
      if (!allowedUids.includes(uid)) return json({ error: "Coach access is not enabled for this account" }, 403, cors);

      let payload: CoachRequest;
      let transcript: string | undefined;
      const contentType = request.headers.get("Content-Type") ?? "";

      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const audio = form.get("audio");
        const context = form.get("context");
        if (!audio || typeof audio === "string" || typeof context !== "string") throw new Error("Invalid audio request");
        if ((audio as File).size > 15 * 1024 * 1024) throw new Error("Voice memo is too large");
        transcript = await transcribe(audio as File, env.OPENAI_API_KEY);
        payload = { ...(JSON.parse(context) as CoachRequest), message: transcript };
      } else {
        payload = await request.json<CoachRequest>();
      }

      const result = await askCoach(payload, env.OPENAI_API_KEY);
      return json({ ...result, transcript }, 200, cors);
    } catch (error) {
      console.error(error);
      return json({ error: error instanceof Error ? error.message : "Coach request failed" }, 500, cors);
    }
  },
};

function getCorsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://ninetalesgames.github.io",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function verifyFirebaseUser(request: Request, env: Env) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Error("Sign in is required");

  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: authorization.slice(7) }),
  });
  const data = await response.json<{ users?: Array<{ localId: string }> }>();
  const uid = data.users?.[0]?.localId;
  if (!response.ok || !uid) throw new Error("Invalid Firebase session");
  return uid;
}

async function transcribe(audio: File, apiKey: string) {
  const form = new FormData();
  form.set("file", audio, audio.name || "voice.webm");
  form.set("model", "gpt-4o-mini-transcribe");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = await response.json<{ text?: string; error?: { message?: string } }>();
  if (!response.ok || !data.text) throw new Error(data.error?.message ?? "Transcription failed");
  return data.text;
}

async function askCoach(payload: CoachRequest, apiKey: string): Promise<CoachResult> {
  const instructions = `You are a concise nutrition journal coach. Use the supplied journal context to answer questions.
You may propose meal logs, weight logs, or calorie/protein goal changes, but never claim they are already saved.
Nutrition values are estimates. When portions or brands are unclear, state that in uncertainty.
Meal proposals add to a day's existing totals. Weight proposals replace that day's weight.
Goal changes require both calorieTarget and proteinTarget. Default proposal dates to ${payload.today}, unless the user states another date.
Return no proposal for ordinary advice or questions. Dates must be YYYY-MM-DD.`;

  const context = {
    today: payload.today,
    selectedDate: payload.selectedDate,
    goals: payload.goals,
    recentEntries: payload.entries,
    recentMealLogs: payload.mealLogs,
    recentMessages: payload.recentMessages,
    userMessage: payload.message,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      instructions,
      input: JSON.stringify(context),
      text: {
        format: {
          type: "json_schema",
          name: "coach_response",
          strict: true,
          schema: responseSchema,
        },
      },
    }),
  });

  const data = await response.json<{
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    error?: { message?: string };
  }>();
  const outputText = data.output_text ?? data.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("");
  if (!response.ok || !outputText) throw new Error(data.error?.message ?? "Coach response failed");
  return JSON.parse(outputText) as CoachResult;
}
