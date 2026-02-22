import { z } from "zod";

export const assetTypeSchema = z.enum(["audio_preview", "audio_source", "midi"]);
export const assetFormatSchema = z.enum(["mp3", "wav", "mid"]);
export const mixSessionBaseSchema = z.enum(["active", "latest"]);

export const createBandSchema = z.object({
  name: z.string().min(1).max(120)
});

export const joinBandSchema = z.object({
  invite_code: z.string().min(4).max(32)
});

export const createSongSchema = z.object({
  title: z.string().min(1).max(200),
  bpm: z.number().int().min(1).max(400).optional(),
  key: z.string().max(32).optional(),
  time_signature: z.string().max(16).optional(),
  description: z.string().max(2000).optional()
});

export const updateSongSchema = createSongSchema.partial();

export const createTrackSchema = z.object({
  name: z.string().min(1).max(200),
  instrument_type: z.string().max(100).optional()
});

export const updateTrackSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  instrument_type: z.string().max(100).optional(),
  sort_order: z.number().int().optional(),
  active_revision_id: z.string().uuid().nullable().optional()
});

export const createRevisionSchema = z.object({
  title: z.string().max(200).optional(),
  memo: z.string().max(4000).optional(),
  idempotency_key: z.string().max(120).optional()
});

export const setActiveRevisionSchema = z.object({
  track_revision_id: z.string().uuid()
});

export const presignAssetSchema = z.object({
  asset_type: assetTypeSchema,
  format: assetFormatSchema,
  content_type: z.string().min(1).max(120),
  byte_size: z.number().int().positive().optional(),
  filename: z.string().max(255).optional()
});

export const completeAssetSchema = z.object({
  byte_size: z.number().int().positive().optional(),
  duration_sec: z.number().positive().optional(),
  sample_rate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional()
});

export const createSessionSchema = z.object({
  name: z.string().min(1).max(200),
  base: mixSessionBaseSchema
});

export const updateSessionTracksSchema = z.object({
  tracks: z
    .array(
      z.object({
        track_id: z.string().uuid(),
        track_revision_id: z.string().uuid().nullable(),
        mute: z.boolean().default(false),
        gain_db: z.number().min(-60).max(12).default(0),
        pan: z.number().min(-1).max(1).default(0),
        start_offset_ms: z.number().int().min(0).max(600000).default(0)
      })
    )
    .max(256)
});

export const createNoteSchema = z.object({
  content: z.string().min(1).max(5000)
});

export const updateNoteSchema = z.object({
  content: z.string().min(1).max(5000)
});

export const createDecisionSchema = z.object({
  title: z.string().min(1).max(200),
  decision_text: z.string().min(1).max(8000),
  reasoning: z.string().max(8000).optional(),
  related_track_id: z.string().uuid().optional().nullable(),
  related_track_revision_id: z.string().uuid().optional().nullable()
});

export const updateDecisionSchema = createDecisionSchema.partial();

export type AssetType = z.infer<typeof assetTypeSchema>;
export type AssetFormat = z.infer<typeof assetFormatSchema>;
