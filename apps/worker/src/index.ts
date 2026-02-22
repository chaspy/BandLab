import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  completeAssetSchema,
  createBandSchema,
  createDecisionSchema,
  createNoteSchema,
  createRevisionSchema,
  createSessionSchema,
  createSongSchema,
  createTrackSchema,
  joinBandSchema,
  presignAssetSchema,
  setActiveRevisionSchema,
  updateDecisionSchema,
  updateNoteSchema,
  updateSessionTracksSchema,
  updateSongSchema,
  updateTrackSchema
} from "@bandlab/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { WORKER_CONFIG } from "./config";

type Env = {
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

type Variables = {
  userId: string;
  db: SupabaseClient;
  s3: S3Client;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function readSecret(c: { env: Env }, key: keyof Env): string {
  const binding = c.env[key];
  if (binding) return binding;

  const runtimeEnv =
    (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env || {};
  const value = runtimeEnv[key];
  if (value) return value;

  throw new Error(`${String(key)} is not configured`);
}

app.use(
  "/*",
  cors({
    origin: (origin, c) => {
      const allowed = WORKER_CONFIG.appOrigin;
      if (!origin) return allowed;
      return origin === allowed ? origin : allowed;
    },
    allowHeaders: ["Authorization", "Content-Type", "Range", "X-Band-Id"],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Range", "Accept-Ranges", "Content-Length", "Content-Type"]
  })
);

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") {
    return next();
  }

  const auth = c.req.header("Authorization");
  const bearerToken = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  const queryToken = c.req.query("token");
  const token = bearerToken || (c.req.path.endsWith("/stream") ? queryToken || "" : "");
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const anonClient = createClient(WORKER_CONFIG.supabaseUrl, readSecret(c, "SUPABASE_ANON_KEY"));
  const userRes = await anonClient.auth.getUser(token);
  if (userRes.error || !userRes.data.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const db = createClient(WORKER_CONFIG.supabaseUrl, readSecret(c, "SUPABASE_SERVICE_ROLE_KEY"));
  const s3 = new S3Client({
    region: WORKER_CONFIG.s3Region,
    endpoint: WORKER_CONFIG.s3Endpoint,
    credentials: {
      accessKeyId: WORKER_CONFIG.s3AccessKey,
      secretAccessKey: WORKER_CONFIG.s3SecretKey
    },
    forcePathStyle: true
  });

  c.set("userId", userRes.data.user.id);
  c.set("db", db);
  c.set("s3", s3);

  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/me", async (c) => {
  const userId = c.get("userId");
  const db = c.get("db");

  const bandsRes = await db
    .from("band_members")
    .select("band_id, role, bands(*)")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true });

  if (bandsRes.error) return c.json({ error: bandsRes.error.message }, 500);

  return c.json({
    user: { id: userId },
    bands: (bandsRes.data ?? []).map((row) => ({
      ...row.bands,
      role: row.role
    }))
  });
});

app.post("/api/bands", zValidator("json", createBandSchema), async (c) => {
  const userId = c.get("userId");
  const db = c.get("db");
  const body = c.req.valid("json");

  const inviteCode = makeInviteCode();
  const bandRes = await db
    .from("bands")
    .insert({
      name: body.name,
      invite_code: inviteCode,
      created_by: userId
    })
    .select("*")
    .single();

  if (bandRes.error) return c.json({ error: bandRes.error.message }, 500);

  const memberRes = await db.from("band_members").insert({
    band_id: bandRes.data.id,
    user_id: userId,
    role: "member"
  });

  if (memberRes.error) return c.json({ error: memberRes.error.message }, 500);

  return c.json({ band: bandRes.data, invite_code: inviteCode });
});

app.post("/api/bands/join", zValidator("json", joinBandSchema), async (c) => {
  const userId = c.get("userId");
  const db = c.get("db");
  const body = c.req.valid("json");

  const bandRes = await db.from("bands").select("*").eq("invite_code", body.invite_code).single();
  if (bandRes.error) return c.json({ error: "Band not found" }, 404);

  const memberRes = await db.from("band_members").upsert(
    {
      band_id: bandRes.data.id,
      user_id: userId,
      role: "member"
    },
    { onConflict: "band_id,user_id" }
  );

  if (memberRes.error) return c.json({ error: memberRes.error.message }, 500);

  return c.json({ band: bandRes.data });
});

app.get("/api/songs", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const bandId = c.req.header("x-band-id");
  if (!bandId) return c.json({ error: "x-band-id is required" }, 400);

  if (!(await isBandMember(db, bandId, userId))) return c.json({ error: "Forbidden" }, 403);

  const songsRes = await db.from("songs").select("*").eq("band_id", bandId).order("created_at", { ascending: false });
  if (songsRes.error) return c.json({ error: songsRes.error.message }, 500);

  return c.json({ songs: songsRes.data ?? [] });
});

app.post("/api/songs", zValidator("json", createSongSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const bandId = c.req.header("x-band-id");
  if (!bandId) return c.json({ error: "x-band-id is required" }, 400);

  if (!(await isBandMember(db, bandId, userId))) return c.json({ error: "Forbidden" }, 403);

  const body = c.req.valid("json");
  const res = await db
    .from("songs")
    .insert({
      band_id: bandId,
      title: body.title,
      bpm: body.bpm ?? null,
      musical_key: body.key ?? null,
      time_signature: body.time_signature ?? null,
      description: body.description ?? null,
      created_by: userId
    })
    .select("*")
    .single();

  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ song: res.data });
});

app.get("/api/songs/:songId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();

  const songRes = await db.from("songs").select("*").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);

  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  return c.json({ song: songRes.data });
});

app.patch("/api/songs/:songId", zValidator("json", updateSongSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();
  const body = c.req.valid("json");

  const songRes = await db.from("songs").select("*").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);
  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const updated = await db
    .from("songs")
    .update({
      title: body.title,
      bpm: body.bpm,
      musical_key: body.key,
      time_signature: body.time_signature,
      description: body.description,
      updated_at: new Date().toISOString()
    })
    .eq("id", songId)
    .select("*")
    .single();

  if (updated.error) return c.json({ error: updated.error.message }, 500);
  return c.json({ song: updated.data });
});

app.get("/api/songs/:songId/tracks", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();

  const songRes = await db.from("songs").select("band_id").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);
  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const tracksRes = await db.from("tracks").select("*").eq("song_id", songId).order("sort_order", { ascending: true });
  if (tracksRes.error) return c.json({ error: tracksRes.error.message }, 500);

  return c.json({ tracks: tracksRes.data ?? [] });
});

app.post("/api/songs/:songId/tracks", zValidator("json", createTrackSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();
  const body = c.req.valid("json");

  const songRes = await db.from("songs").select("band_id").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);
  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const maxOrderRes = await db.from("tracks").select("sort_order").eq("song_id", songId).order("sort_order", { ascending: false }).limit(1).maybeSingle();

  const sortOrder = maxOrderRes.data?.sort_order ? maxOrderRes.data.sort_order + 1 : 1;
  const trackRes = await db
    .from("tracks")
    .insert({
      song_id: songId,
      name: body.name,
      instrument_type: body.instrument_type ?? null,
      sort_order: sortOrder,
      created_by: userId
    })
    .select("*")
    .single();

  if (trackRes.error) return c.json({ error: trackRes.error.message }, 500);
  return c.json({ track: trackRes.data });
});

app.patch("/api/tracks/:trackId", zValidator("json", updateTrackSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { trackId } = c.req.param();
  const body = c.req.valid("json");

  const trackRes = await getTrackWithBand(db, trackId);
  if (!trackRes) return c.json({ error: "Track not found" }, 404);
  if (!(await isBandMember(db, trackRes.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const updated = await db
    .from("tracks")
    .update({
      name: body.name,
      instrument_type: body.instrument_type,
      sort_order: body.sort_order,
      active_revision_id: body.active_revision_id,
      updated_at: new Date().toISOString()
    })
    .eq("id", trackId)
    .select("*")
    .single();

  if (updated.error) return c.json({ error: updated.error.message }, 500);
  return c.json({ track: updated.data });
});

app.get("/api/tracks/:trackId/revisions", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { trackId } = c.req.param();

  const trackRes = await getTrackWithBand(db, trackId);
  if (!trackRes) return c.json({ error: "Track not found" }, 404);
  if (!(await isBandMember(db, trackRes.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const revisionsRes = await db
    .from("track_revisions")
    .select("*, track_assets(*)")
    .eq("track_id", trackId)
    .order("revision_number", { ascending: true });

  if (revisionsRes.error) return c.json({ error: revisionsRes.error.message }, 500);
  return c.json({ revisions: revisionsRes.data ?? [] });
});

app.post("/api/tracks/:trackId/revisions", zValidator("json", createRevisionSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { trackId } = c.req.param();
  const body = c.req.valid("json");

  const trackRes = await getTrackWithBand(db, trackId);
  if (!trackRes) return c.json({ error: "Track not found" }, 404);
  if (!(await isBandMember(db, trackRes.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  if (body.idempotency_key) {
    const existing = await db
      .from("track_revisions")
      .select("*")
      .eq("track_id", trackId)
      .eq("idempotency_key", body.idempotency_key)
      .maybeSingle();

    if (existing.data) {
      return c.json({ revision: existing.data });
    }
  }

  const revisionNumRes = await db.rpc("allocate_track_revision_number", { p_track_id: trackId });
  if (revisionNumRes.error || typeof revisionNumRes.data !== "number") {
    return c.json({ error: revisionNumRes.error?.message ?? "Failed to allocate revision number" }, 500);
  }

  const revisionRes = await db
    .from("track_revisions")
    .insert({
      track_id: trackId,
      revision_number: revisionNumRes.data,
      title: body.title ?? null,
      memo: body.memo ?? null,
      idempotency_key: body.idempotency_key ?? null,
      created_by: userId
    })
    .select("*")
    .single();

  if (revisionRes.error) {
    if (revisionRes.error.code === "23505") return c.json({ error: "Revision conflict" }, 409);
    return c.json({ error: revisionRes.error.message }, 500);
  }

  return c.json({ revision: revisionRes.data });
});

app.post("/api/tracks/:trackId/active", zValidator("json", setActiveRevisionSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { trackId } = c.req.param();
  const body = c.req.valid("json");

  const trackRes = await getTrackWithBand(db, trackId);
  if (!trackRes) return c.json({ error: "Track not found" }, 404);
  if (!(await isBandMember(db, trackRes.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const revisionRes = await db
    .from("track_revisions")
    .select("id")
    .eq("id", body.track_revision_id)
    .eq("track_id", trackId)
    .single();

  if (revisionRes.error) return c.json({ error: "Revision not found" }, 404);

  const updateRes = await db
    .from("tracks")
    .update({ active_revision_id: body.track_revision_id, updated_at: new Date().toISOString() })
    .eq("id", trackId)
    .select("*")
    .single();

  if (updateRes.error) return c.json({ error: updateRes.error.message }, 500);
  return c.json({ track: updateRes.data });
});

app.post("/api/revisions/:revisionId/assets/presign", zValidator("json", presignAssetSchema), async (c) => {
  const db = c.get("db");
  const s3 = c.get("s3");
  const userId = c.get("userId");
  const { revisionId } = c.req.param();
  const body = c.req.valid("json");

  const revisionRes = await getRevisionWithBand(db, revisionId);
  if (!revisionRes) return c.json({ error: "Revision not found" }, 404);
  if (!(await isBandMember(db, revisionRes.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const assetId = crypto.randomUUID();
  const ext = body.format;
  const s3Key = `${revisionRes.song_id}/${revisionRes.track_id}/${revisionId}/${body.asset_type}-${assetId}.${ext}`;

  const assetInsert = await db
    .from("track_assets")
    .insert({
      id: assetId,
      track_revision_id: revisionId,
      asset_type: body.asset_type,
      format: body.format,
      s3_key: s3Key,
      content_type: body.content_type,
      byte_size: body.byte_size ?? null,
      status: "pending"
    })
    .select("*")
    .single();

  if (assetInsert.error) {
    if (assetInsert.error.code === "23505") {
      return c.json({ error: "Asset type already exists for this revision" }, 409);
    }
    return c.json({ error: assetInsert.error.message }, 500);
  }

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: WORKER_CONFIG.s3Bucket,
      Key: s3Key,
      ContentType: body.content_type
    }),
    { expiresIn: 900 }
  );

  return c.json({
    asset_id: assetId,
    s3_key: s3Key,
    upload_url: uploadUrl,
    required_headers: {
      "Content-Type": body.content_type
    },
    expires_at: new Date(Date.now() + 900 * 1000).toISOString()
  });
});

app.post("/api/assets/:assetId/complete", zValidator("json", completeAssetSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { assetId } = c.req.param();
  const body = c.req.valid("json");

  const assetRes = await getAssetWithBand(db, assetId);
  if (!assetRes) return c.json({ error: "Asset not found" }, 404);
  if (!(await isBandMember(db, assetRes.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const updateRes = await db
    .from("track_assets")
    .update({
      byte_size: body.byte_size,
      duration_sec: body.duration_sec,
      sample_rate: body.sample_rate,
      channels: body.channels,
      status: "ready"
    })
    .eq("id", assetId)
    .select("*")
    .single();

  if (updateRes.error) return c.json({ error: updateRes.error.message }, 500);
  return c.json({ asset: updateRes.data });
});

app.get("/api/assets/:assetId/stream", async (c) => {
  const db = c.get("db");
  const s3 = c.get("s3");
  const userId = c.get("userId");
  const { assetId } = c.req.param();

  const assetRes = await getAssetWithBand(db, assetId);
  if (!assetRes) return c.json({ error: "Asset not found" }, 404);
  if (!(await isBandMember(db, assetRes.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const signedGet = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: WORKER_CONFIG.s3Bucket,
      Key: assetRes.s3_key
    }),
    { expiresIn: 300 }
  );

  const range = c.req.header("range");
  const upstream = await fetch(signedGet, {
    headers: range ? { Range: range } : undefined
  });

  if (!upstream.ok && upstream.status !== 206) {
    return c.json({ error: "Failed to stream asset" }, 502);
  }

  const headers = new Headers();
  headers.set("Content-Type", assetRes.content_type ?? "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");

  const contentRange = upstream.headers.get("Content-Range");
  const contentLength = upstream.headers.get("Content-Length");
  if (contentRange) headers.set("Content-Range", contentRange);
  if (contentLength) headers.set("Content-Length", contentLength);

  return new Response(upstream.body, {
    status: upstream.status,
    headers
  });
});

app.get("/api/songs/:songId/sessions", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();

  const songRes = await db.from("songs").select("band_id").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);
  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const res = await db.from("mix_sessions").select("*").eq("song_id", songId).order("created_at", { ascending: false });
  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ sessions: res.data ?? [] });
});

app.post("/api/songs/:songId/sessions", zValidator("json", createSessionSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();
  const body = c.req.valid("json");

  const songRes = await db.from("songs").select("band_id").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);
  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const sessionRes = await db
    .from("mix_sessions")
    .insert({ song_id: songId, name: body.name, created_by: userId })
    .select("*")
    .single();

  if (sessionRes.error) return c.json({ error: sessionRes.error.message }, 500);

  const tracksRes = await db.from("tracks").select("id, active_revision_id").eq("song_id", songId).order("sort_order", { ascending: true });
  if (tracksRes.error) return c.json({ error: tracksRes.error.message }, 500);

  let snapshot: Array<{ track_id: string; track_revision_id: string | null }> = [];
  if (body.base === "active") {
    snapshot = (tracksRes.data ?? []).map((t) => ({ track_id: t.id, track_revision_id: t.active_revision_id }));
  } else {
    const latestRes = await db
      .from("track_revisions")
      .select("track_id, id, revision_number")
      .in(
        "track_id",
        (tracksRes.data ?? []).map((t) => t.id)
      )
      .order("revision_number", { ascending: false });

    if (latestRes.error) return c.json({ error: latestRes.error.message }, 500);

    const map = new Map<string, string>();
    for (const row of latestRes.data ?? []) {
      if (!map.has(row.track_id)) map.set(row.track_id, row.id);
    }
    snapshot = (tracksRes.data ?? []).map((t) => ({ track_id: t.id, track_revision_id: map.get(t.id) ?? null }));
  }

  if (snapshot.length > 0) {
    const insert = await db.from("mix_session_tracks").insert(
      snapshot.map((s) => ({
        mix_session_id: sessionRes.data.id,
        track_id: s.track_id,
        track_revision_id: s.track_revision_id,
        mute: false,
        gain_db: 0,
        pan: 0,
        start_offset_ms: 0
      }))
    );
    if (insert.error) return c.json({ error: insert.error.message }, 500);
  }

  return c.json({ session: sessionRes.data });
});

app.get("/api/sessions/:sessionId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { sessionId } = c.req.param();

  const sessionRes = await db
    .from("mix_sessions")
    .select("*, songs!inner(band_id), mix_session_tracks(*)")
    .eq("id", sessionId)
    .single();

  if (sessionRes.error) return c.json({ error: "Session not found" }, 404);
  const sessionSong = relationOne<{ band_id: string }>(sessionRes.data.songs);
  if (!sessionSong || !(await isBandMember(db, sessionSong.band_id, userId))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  return c.json({
    session: {
      ...sessionRes.data,
      tracks: sessionRes.data.mix_session_tracks ?? []
    }
  });
});

app.put("/api/sessions/:sessionId/tracks", zValidator("json", updateSessionTracksSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { sessionId } = c.req.param();
  const body = c.req.valid("json");

  const sessionRes = await db.from("mix_sessions").select("id, song_id, songs!inner(band_id)").eq("id", sessionId).single();
  if (sessionRes.error) return c.json({ error: "Session not found" }, 404);
  const sessionSong = relationOne<{ band_id: string }>(sessionRes.data.songs);
  if (!sessionSong || !(await isBandMember(db, sessionSong.band_id, userId))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const upsertRes = await db.from("mix_session_tracks").upsert(
    body.tracks.map((t) => ({
      mix_session_id: sessionId,
      track_id: t.track_id,
      track_revision_id: t.track_revision_id,
      mute: t.mute,
      gain_db: t.gain_db,
      pan: t.pan,
      start_offset_ms: t.start_offset_ms
    })),
    { onConflict: "mix_session_id,track_id" }
  );

  if (upsertRes.error) return c.json({ error: upsertRes.error.message }, 500);
  return c.json({ ok: true });
});

app.get("/api/songs/:songId/notes", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();

  const songRes = await db.from("songs").select("band_id").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);
  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const res = await db.from("notes").select("*").eq("song_id", songId).order("created_at", { ascending: false });
  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ notes: res.data ?? [] });
});

app.post("/api/songs/:songId/notes", zValidator("json", createNoteSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();
  const body = c.req.valid("json");

  const songRes = await db.from("songs").select("band_id").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);
  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const res = await db
    .from("notes")
    .insert({ song_id: songId, content: body.content, created_by: userId })
    .select("*")
    .single();

  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ note: res.data });
});

app.patch("/api/notes/:noteId", zValidator("json", updateNoteSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { noteId } = c.req.param();
  const body = c.req.valid("json");

  const noteRes = await db.from("notes").select("id, song_id, songs!inner(band_id)").eq("id", noteId).single();
  if (noteRes.error) return c.json({ error: "Note not found" }, 404);
  const noteSong = relationOne<{ band_id: string }>(noteRes.data.songs);
  if (!noteSong || !(await isBandMember(db, noteSong.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const res = await db
    .from("notes")
    .update({ content: body.content, updated_at: new Date().toISOString() })
    .eq("id", noteId)
    .select("*")
    .single();

  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ note: res.data });
});

app.delete("/api/notes/:noteId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { noteId } = c.req.param();

  const noteRes = await db.from("notes").select("id, songs!inner(band_id)").eq("id", noteId).single();
  if (noteRes.error) return c.json({ error: "Note not found" }, 404);
  const noteSong = relationOne<{ band_id: string }>(noteRes.data.songs);
  if (!noteSong || !(await isBandMember(db, noteSong.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const res = await db.from("notes").delete().eq("id", noteId);
  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ ok: true });
});

app.get("/api/songs/:songId/decisions", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();

  const songRes = await db.from("songs").select("band_id").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);
  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const res = await db.from("decisions").select("*").eq("song_id", songId).order("created_at", { ascending: false });
  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ decisions: res.data ?? [] });
});

app.post("/api/songs/:songId/decisions", zValidator("json", createDecisionSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { songId } = c.req.param();
  const body = c.req.valid("json");

  const songRes = await db.from("songs").select("band_id").eq("id", songId).single();
  if (songRes.error) return c.json({ error: "Song not found" }, 404);
  if (!(await isBandMember(db, songRes.data.band_id, userId))) return c.json({ error: "Forbidden" }, 403);

  const res = await db
    .from("decisions")
    .insert({
      song_id: songId,
      title: body.title,
      decision_text: body.decision_text,
      reasoning: body.reasoning ?? null,
      related_track_id: body.related_track_id ?? null,
      related_track_revision_id: body.related_track_revision_id ?? null,
      created_by: userId
    })
    .select("*")
    .single();

  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ decision: res.data });
});

app.patch("/api/decisions/:decisionId", zValidator("json", updateDecisionSchema), async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { decisionId } = c.req.param();
  const body = c.req.valid("json");

  const decisionRes = await db.from("decisions").select("id, songs!inner(band_id)").eq("id", decisionId).single();
  if (decisionRes.error) return c.json({ error: "Decision not found" }, 404);
  const decisionSong = relationOne<{ band_id: string }>(decisionRes.data.songs);
  if (!decisionSong || !(await isBandMember(db, decisionSong.band_id, userId))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const res = await db
    .from("decisions")
    .update({
      title: body.title,
      decision_text: body.decision_text,
      reasoning: body.reasoning,
      related_track_id: body.related_track_id,
      related_track_revision_id: body.related_track_revision_id
    })
    .eq("id", decisionId)
    .select("*")
    .single();

  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ decision: res.data });
});

app.delete("/api/decisions/:decisionId", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { decisionId } = c.req.param();

  const decisionRes = await db.from("decisions").select("id, songs!inner(band_id)").eq("id", decisionId).single();
  if (decisionRes.error) return c.json({ error: "Decision not found" }, 404);
  const decisionSong = relationOne<{ band_id: string }>(decisionRes.data.songs);
  if (!decisionSong || !(await isBandMember(db, decisionSong.band_id, userId))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const res = await db.from("decisions").delete().eq("id", decisionId);
  if (res.error) return c.json({ error: res.error.message }, 500);
  return c.json({ ok: true });
});

async function isBandMember(db: SupabaseClient, bandId: string, userId: string): Promise<boolean> {
  const res = await db
    .from("band_members")
    .select("band_id")
    .eq("band_id", bandId)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(res.data);
}

async function getTrackWithBand(db: SupabaseClient, trackId: string) {
  const res = await db
    .from("tracks")
    .select("id, song_id, songs!inner(band_id)")
    .eq("id", trackId)
    .single();

  if (res.error) return null;
  const row = res.data as any;
  const song = relationOne<any>(row.songs);
  return {
    id: row.id as string,
    song_id: row.song_id as string,
    band_id: (song?.band_id ?? "") as string
  };
}

async function getRevisionWithBand(db: SupabaseClient, revisionId: string) {
  const res = await db
    .from("track_revisions")
    .select("id, track_id, tracks!track_revisions_track_id_fkey!inner(song_id, songs!inner(band_id))")
    .eq("id", revisionId)
    .single();

  if (res.error) return null;

  const row = res.data as any;
  const track = relationOne<any>(row.tracks);
  const song = relationOne<any>(track?.songs);
  return {
    id: row.id as string,
    track_id: row.track_id as string,
    song_id: (track?.song_id ?? "") as string,
    band_id: (song?.band_id ?? "") as string
  };
}

async function getAssetWithBand(db: SupabaseClient, assetId: string) {
  const res = await db
    .from("track_assets")
    .select(
      "id, s3_key, content_type, track_revisions!track_assets_track_revision_id_fkey!inner(track_id, tracks!track_revisions_track_id_fkey!inner(song_id, songs!inner(band_id)))"
    )
    .eq("id", assetId)
    .single();

  if (res.error) return null;

  const row = res.data as any;
  const revision = relationOne<any>(row.track_revisions);
  const track = relationOne<any>(revision?.tracks);
  const song = relationOne<any>(track?.songs);
  return {
    id: row.id as string,
    s3_key: row.s3_key as string,
    content_type: row.content_type as string,
    band_id: (song?.band_id ?? "") as string
  };
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function makeInviteCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

export default app;
