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
      let imageDataUrl: string | undefined;
      const contentType = request.headers.get("Content-Type") ?? "";

      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const audio = form.get("audio");
        const image = form.get("image");
        const context = form.get("context");
        if (typeof context !== "string") throw new Error("Invalid Coach request");
        payload = JSON.parse(context) as CoachRequest;

        if (audio && typeof audio !== "string") {
          if ((audio as File).size > 15 * 1024 * 1024) throw new Error("Voice memo is too large");
          transcript = await transcribe(audio as File, env.OPENAI_API_KEY);
          payload = { ...payload, message: transcript };
        } else if (image && typeof image !== "string") {
          if (!(image as File).type.startsWith("image/")) throw new Error("Unsupported photo format");
          if ((image as File).size > 10 * 1024 * 1024) throw new Error("Meal photo is too large");
          imageDataUrl = await fileToDataUrl(image as File);
        } else {
          throw new Error("Audio or meal photo is required");
        }
      } else {
        payload = await request.json<CoachRequest>();
      }

      const result = await askCoach(payload, env.OPENAI_API_KEY, imageDataUrl);
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
  form.set("file", audio, getAudioFilename(audio.type, audio.name));
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

async function fileToDataUrl(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
}

function getAudioFilename(mimeType: string, originalName: string) {
  if (mimeType.includes("mp4")) return "voice.m4a";
  if (mimeType.includes("ogg")) return "voice.ogg";
  if (mimeType.includes("mpeg")) return "voice.mp3";
  if (mimeType.includes("wav")) return "voice.wav";
  if (mimeType.includes("webm")) return "voice.webm";
  return originalName || "voice.webm";
}

async function askCoach(payload: CoachRequest, apiKey: string, imageDataUrl?: string): Promise<CoachResult> {
  const instructions = `You are a concise nutrition journal coach. Use the supplied journal context to answer questions.
You may propose meal logs, weight logs, or calorie/protein goal changes, but never claim they are already saved.
Nutrition values are estimates. When portions or brands are unclear, state that in uncertainty.
Meal proposals add to a day's existing totals. Weight proposals replace that day's weight.
Meal proposal summaries must preserve the actual foods, quantities, brands, and preparation details the user states, for example "700g diced lean beef".
Every meal proposal MUST contain non-null integer estimates for both calories and protein. Make a reasonable estimate even when the transcript is not English or portions are uncertain, and explain uncertainty rather than leaving either value null.
When a meal photo is supplied, identify visible foods, estimate portions, and return one meal proposal with calories and protein. Clearly explain visual uncertainty.
If today's journal entry already contains weight, do not propose another weight update for today.
Goal changes require both calorieTarget and proteinTarget. Default proposal dates to ${payload.today}, unless the user states another date.
For recovery, fatigue, or performance questions, analyze recent calories, protein, weight trend, notes, and meal patterns. Explain possible diet relationships while also mentioning non-diet factors such as sleep, hydration, training load, stress, and illness when relevant. Do not diagnose medical conditions.
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

  let result = await requestCoachResponse(instructions, context, apiKey, imageDataUrl);

  if (hasIncompleteMeal(result)) {
    result = await requestCoachResponse(
      `${instructions}
Your previous response contained a meal proposal with blank calories or protein. Correct it now: every meal proposal must include your best integer estimate for both values.`,
      context,
      apiKey,
      imageDataUrl,
    );
  }

  if (hasIncompleteMeal(result)) throw new Error("Could not estimate calories and protein for this meal. Please include foods and approximate amounts.");
  return result;
}

function hasIncompleteMeal(result: CoachResult) {
  return result.proposals.some((proposal) =>
    proposal.type === "meal" && (typeof proposal.calories !== "number" || typeof proposal.protein !== "number"),
  );
}

async function requestCoachResponse(instructions: string, context: object, apiKey: string, imageDataUrl?: string): Promise<CoachResult> {
  const input = imageDataUrl
    ? [{
        role: "user",
        content: [
          { type: "input_text", text: JSON.stringify(context) },
          { type: "input_image", image_url: imageDataUrl },
        ],
      }]
    : JSON.stringify(context);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      instructions,
      input,
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
