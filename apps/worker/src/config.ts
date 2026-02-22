export const WORKER_CONFIG = {
  supabaseUrl: "http://127.0.0.1:54321",
  s3Endpoint: "http://localhost:9000",
  s3Region: "us-east-1",
  s3Bucket: "band-daw",
  s3AccessKey: "minioadmin",
  s3SecretKey: "minioadmin",
  appOrigin: "http://localhost:3000"
} as const;
