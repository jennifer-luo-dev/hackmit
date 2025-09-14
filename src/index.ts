import {
  AppServer,
  AppSession,
  AuthenticatedRequest,
  PhotoData,
} from "@mentra/sdk";
import * as ejs from "ejs";
import * as path from "path";
import { promises as fs } from "fs"; // ← ADD

/**
 * Interface representing a stored photo with metadata
 */
interface StoredPhoto {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string; // basename only, e.g. "photo_...jpg"
  size: number;
}

// === Added: snapshots setup helpers ===
const SNAPSHOTS_DIR = path.join(process.cwd(), "snapshots");

function extFromMime(mime: string | undefined): string {
  if (!mime) return ".bin";
  // crude but effective; extend if you expect other formats
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/bmp") return ".bmp";
  if (mime === "image/tiff") return ".tiff";
  return ".bin";
}

function safeTimestamp(d: Date) {
  // filename-safe ISO (no colons)
  return d.toISOString().replace(/[:]/g, "-");
}

async function ensureSnapshotsDirExists(logger: { info: Function; warn: Function }) {
  try {
    await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
    logger.info(`Snapshots directory ready at: ${SNAPSHOTS_DIR}`);
  } catch (e) {
    logger.warn(`Could not create snapshots directory: ${e}`);
  }
}
// === end helpers ===

const PACKAGE_NAME =
  process.env.PACKAGE_NAME ??
  (() => {
    throw new Error("PACKAGE_NAME is not set in .env file");
  })();
const MENTRAOS_API_KEY =
  process.env.MENTRAOS_API_KEY ??
  (() => {
    throw new Error("MENTRAOS_API_KEY is not set in .env file");
  })();
const PORT = parseInt(process.env.PORT || "3000");

/**
 * Photo Taker App with webview functionality for displaying photos
 * Extends AppServer to provide photo taking and webview display capabilities
 */
class ExampleMentraOSApp extends AppServer {
  private photos: Map<string, StoredPhoto[]> = new Map(); // Store photos by userId (list)
  private latestPhotoTimestamp: Map<string, number> = new Map(); // Track latest photo timestamp per user
  private isStreamingPhotos: Map<string, boolean> = new Map(); // Track if we are streaming photos for a user
  private nextPhotoTime: Map<string, number> = new Map(); // Track next photo time for a user

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: PORT,
    });
    // ensure snapshots dir exists at boot
    ensureSnapshotsDirExists(this.logger);
    this.setupWebviewRoutes();
  }

  /**
   * Handle new session creation and button press events
   */
  protected async onSession(session: AppSession): Promise<void> {
    const sessionId = (session as any).sessionId ?? "unknown";
    const userId =
      (session as any).userId ?? (session as any).user?.id ?? "unknown";

    this.logger.info(`Session ${sessionId} started for user ${userId}`);

    // initialize state
    this.isStreamingPhotos.set(userId, false);
    this.nextPhotoTime.set(userId, Date.now());

    // button press handling
    session.events.onButtonPress(async (button) => {
      this.logger.info(
        `Button pressed: ${button.buttonId}, type: ${button.pressType}`
      );

      if (button.pressType === "long") {
        // toggle streaming mode
        this.isStreamingPhotos.set(
          userId,
          !this.isStreamingPhotos.get(userId)
        );
        this.logger.info(
          `Streaming photos for user ${userId} is now ${this.isStreamingPhotos.get(
            userId
          )}`
        );
      } else {
        session.layouts.showTextWall("Taking photo…", { durationMs: 4000 });
        try {
          const photo = await session.camera.requestPhoto();
          this.logger.info(
            `Photo taken for user ${userId}, timestamp: ${photo.timestamp}`
          );
          await this.cachePhoto(photo, userId); // ← make sure we await (writing file)
        } catch (error) {
          this.logger.error(`Error taking photo: ${error}`);
        }
      }
    });

    // auto-stream loop
    setInterval(async () => {
      if (
        this.isStreamingPhotos.get(userId) &&
        Date.now() > (this.nextPhotoTime.get(userId) ?? 0)
      ) {
        try {
          this.nextPhotoTime.set(userId, Date.now() + 30000);
          const photo = await session.camera.requestPhoto();
          this.nextPhotoTime.set(userId, Date.now());
          await this.cachePhoto(photo, userId); // ← await here too
        } catch (error) {
          this.logger.error(`Error auto-taking photo: ${error}`);
        }
      }
    }, 1000);
  }

  protected async onStop(): Promise<void> {
    this.logger.info("Session stopped, cleaning up user state");
    this.isStreamingPhotos.clear();
    this.nextPhotoTime.clear();
  }

  /**
   * Cache a photo for display AND save it to disk under snapshots/
   */
  private async cachePhoto(photo: PhotoData, userId: string) {
    // Build a filename and write to disk first
    const ext = extFromMime(photo.mimeType);
    const ts = safeTimestamp(photo.timestamp ?? new Date());
    const baseName = `photo_${ts}_${photo.requestId ?? "unknown"}${ext}`;
    const fullPath = path.join(SNAPSHOTS_DIR, baseName);

    try {
      await fs.writeFile(fullPath, photo.buffer);
      this.logger.info(`Photo saved to file: ${fullPath}`);
    } catch (e) {
      this.logger.error(`Failed to save photo to file: ${e}`);
      // continue anyway; we still keep it in memory
    }

    const cachedPhoto: StoredPhoto = {
      requestId: photo.requestId,
      buffer: photo.buffer,
      timestamp: photo.timestamp,
      userId,
      mimeType: photo.mimeType,
      filename: baseName, // store basename for APIs/UI
      size: photo.size,
    };

    const list = this.photos.get(userId) ?? [];
    // keep newest first
    list.unshift(cachedPhoto);
    // limit memory: keep last 50 photos per user
    if (list.length > 50) list.length = 50;
    this.photos.set(userId, list);
    this.latestPhotoTimestamp.set(userId, cachedPhoto.timestamp.getTime());
    this.logger.info(
      `Photo cached for user ${userId}, timestamp: ${cachedPhoto.timestamp}`
    );
  }

  /**
   * Set up webview routes for photo display functionality
   */
  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();

    // latest photo metadata
    app.get("/api/latest-photo", (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const list = this.photos.get(userId) ?? [];
      const photo = list[0];
      if (!photo) {
        res.status(404).json({ error: "No photo available" });
        return;
      }
      res.json({
        requestId: photo.requestId,
        timestamp: photo.timestamp.getTime(),
        hasPhoto: true,
      });
    });

    // list of photos metadata (newest first)
    app.get("/api/photos", (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const list = this.photos.get(userId) ?? [];
      res.json(
        list.map((p) => ({
          requestId: p.requestId,
          timestamp: p.timestamp.getTime(),
          filename: p.filename, // will show saved filename
          size: p.size,
          mimeType: p.mimeType,
        }))
      );
    });

    // photo binary
    app.get("/api/photo/:requestId", (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      const requestId = req.params.requestId;
      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const list = this.photos.get(userId) ?? [];
      const photo = list.find((p) => p.requestId === requestId);
      if (!photo) {
        res.status(404).json({ error: "Photo not found" });
        return;
      }
      res.set({
        "Content-Type": photo.mimeType,
        "Cache-Control": "no-cache",
      });
      res.send(photo.buffer);
    });

    // main webview
    app.get("/webview", async (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      if (!userId) {
        res
          .status(401)
          .send(
            `<html><head><title>Not Authenticated</title></head><body><h1>Please open from MentraOS app</h1></body></html>`
          );
        return;
      }
      const templatePath = path.join(process.cwd(), "views", "photo-viewer.ejs");
      const html = await ejs.renderFile(templatePath, {});
      res.send(html);
    });

    app.get("/", (_req, res) => res.redirect("/webview"));
  }
}

// Boot the server
const app = new ExampleMentraOSApp();
app.start().catch(console.error);
