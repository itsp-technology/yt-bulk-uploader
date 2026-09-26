// frontend/src/utils/chunkUploader.ts

export interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  speedMBps: number;
}

interface ChunkUploadResult {
  status: number;
  responseText: string;
  rangeHeader: string | null;
}

export class ResumableChunkUploader {
  private file: File;
  private uploadUri: string;

  // Must stay a multiple of 256 KiB (YouTube requirement: 262,144 bytes)
  private readonly CHUNK_UNIT = 256 * 1024;
  private minChunkSize = 8 * 1024 * 1024;    // 8MB floor
  private maxChunkSize = 128 * 1024 * 1024;  // 128MB ceiling
  private chunkSize = 16 * 1024 * 1024;     // 16MB initial probe

  private isPaused = false;
  private isCancelled = false;
  private activeXhr: XMLHttpRequest | null = null;
  private onProgress: (p: UploadProgress) => void;

  constructor(file: File, uploadUri: string, onProgress: (p: UploadProgress) => void) {
    this.file = file;
    this.uploadUri = uploadUri;
    this.onProgress = onProgress;
  }

  async start(): Promise<{ videoId: string }> {
    let startByte = await this.getResumedOffset();

    // If offset query indicates file is already complete on YouTube, confirm immediately
    if (startByte >= this.file.size) {
      const verify = await this.checkIfCompleted(3);
      if (verify.completed) {
        this.emitProgress(this.file.size, 0);
        return { videoId: verify.videoId };
      }
    } else if (startByte > 0) {
      // Show actual progress immediately if recovering a session mid-stream
      this.emitProgress(startByte, 0);
    }

    while (startByte < this.file.size) {
      if (this.isCancelled) throw new Error('Upload cancelled');
      await this.waitWhilePaused();

      let chunkSuccess = false;
      let attempt = 0;
      const maxRetries = 6;

      while (!chunkSuccess && attempt < maxRetries) {
        if (this.isCancelled) throw new Error('Upload cancelled');
        await this.waitWhilePaused();

        // Freshly computed per attempt to respect shrinkChunkSize() calls
        const endByte = Math.min(startByte + this.chunkSize, this.file.size);
        const chunk = this.file.slice(startByte, endByte);
        const attemptStartTime = Date.now();
        const initialChunkStart = startByte;

        try {
          const result = await this.uploadChunkXHR(
            chunk,
            startByte,
            endByte - 1,
            this.file.size
          );

          if (result.status === 200 || result.status === 201) {
            let videoId = '';
            try {
              const data = JSON.parse(result.responseText);
              videoId = data.id || '';
            } catch {}

            this.emitProgress(this.file.size, 0);
            return { videoId };
          }

          if (result.status === 308) {
            const range = result.rangeHeader;
            let bytesCommitted = 0;

            if (range) {
              const match = range.match(/bytes=\d+-(\d+)/i);
              if (match && match[1]) {
                const nextExpectedByte = parseInt(match[1], 10) + 1;
                bytesCommitted = nextExpectedByte - startByte;
                startByte = nextExpectedByte;
              } else {
                // If header format is unexpected, sync with Google directly
                startByte = await this.getResumedOffset();
                bytesCommitted = startByte - initialChunkStart;
              }
            } else {
              // 308 without Range header means 0 bytes were saved; check ground truth
              const verifiedOffset = await this.getResumedOffset();
              if (verifiedOffset > startByte) {
                bytesCommitted = verifiedOffset - startByte;
                startByte = verifiedOffset;
              } else {
                throw new Error('Google returned HTTP 308 but zero bytes were committed');
              }
            }

            chunkSuccess = true;

            const durationSec = Math.max((Date.now() - attemptStartTime) / 1000, 0.05);
            const actualTransferred = Math.max(bytesCommitted, 0);
            const chunkSpeed = actualTransferred / (1024 * 1024) / durationSec;

            this.emitProgress(startByte, chunkSpeed);
            this.adaptChunkSize(actualTransferred, durationSec);
          } else {
            // Fast-fail permanent HTTP errors immediately without wasting retries
            if ([400, 401, 403, 404, 410].includes(result.status)) {
              throw Object.assign(
                new Error(`Upload session rejected with HTTP ${result.status} (expired or invalid)`),
                { permanent: true }
              );
            }
            throw new Error(`Google rejected chunk with status ${result.status}`);
          }
        } catch (err: any) {
          // Intentional aborts (pause/cancel) should not penalize retries or chunk size
          if (err?.intentional) {
            if (this.isCancelled) throw new Error('Upload cancelled');
            await this.waitWhilePaused();

            // Re-sync with YouTube on resume to capture any bytes accepted before pause
            const resumedOffset = await this.getResumedOffset();
            if (resumedOffset > startByte) {
              startByte = resumedOffset;
              chunkSuccess = true;
            }
            continue;
          }

          // Abort immediately on unrecoverable session errors
          if (err?.permanent) {
            throw err;
          }

          attempt++;
          this.shrinkChunkSize();

          // Check if the final chunk was actually accepted before retrying
          if (endByte >= this.file.size) {
            await new Promise((r) => setTimeout(r, 1500));
            const verify = await this.checkIfCompleted(3);
            if (verify.completed) {
              this.emitProgress(this.file.size, 0);
              return { videoId: verify.videoId };
            }
          }

          if (attempt >= maxRetries) {
            throw err;
          }

          const delay = Math.min(1000 * Math.pow(2, attempt), 12000);
          await new Promise((r) => setTimeout(r, delay));

          const serverOffset = await this.getResumedOffset();
          if (serverOffset > startByte) {
            startByte = serverOffset;
            chunkSuccess = true;
          }
        }
      }
    }

    // Polled verification gives Google time to complete video container finalization
    const finalStatus = await this.checkIfCompleted(4);
    if (finalStatus.completed) {
      this.emitProgress(this.file.size, 0);
      return { videoId: finalStatus.videoId };
    }

    throw new Error('Upload finished without video ID confirmation from Google');
  }

  private uploadChunkXHR(
    chunk: Blob,
    startByte: number,
    endByteInclusive: number,
    totalBytes: number
  ): Promise<ChunkUploadResult> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.activeXhr = xhr;

      let lastLoaded = 0;
      let lastTime = Date.now();
      let stallTimer: any = null;

      // Stall watchdog: Only abort if 0 bytes have moved for 30 consecutive seconds
      const resetStallWatchdog = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          xhr.abort();
        }, 30000);
      };

      xhr.open('PUT', this.uploadUri, true);
      xhr.setRequestHeader('Content-Range', `bytes ${startByte}-${endByteInclusive}/${totalBytes}`);
      xhr.setRequestHeader('Content-Type', this.file.type || 'application/octet-stream');

      resetStallWatchdog();

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          resetStallWatchdog();

          const now = Date.now();
          const timeDelta = (now - lastTime) / 1000;

          // Dispatch progress every 350ms or immediately on final chunk bytes
          if (timeDelta >= 0.35 || event.loaded === event.total) {
            const bytesDelta = event.loaded - lastLoaded;
            const currentMBps = bytesDelta / (1024 * 1024) / (timeDelta || 0.001);

            const currentTotalUploaded = startByte + event.loaded;
            this.emitProgress(currentTotalUploaded, currentMBps);

            lastLoaded = event.loaded;
            lastTime = now;
          }
        }
      };

      xhr.onload = () => {
        if (stallTimer) clearTimeout(stallTimer);
        this.activeXhr = null;
        resolve({
          status: xhr.status,
          responseText: xhr.responseText,
          rangeHeader: xhr.getResponseHeader('Range'),
        });
      };

      xhr.onerror = async () => {
        if (stallTimer) clearTimeout(stallTimer);
        this.activeXhr = null;

        if (endByteInclusive + 1 >= totalBytes) {
          try {
            const verify = await this.checkIfCompleted(2);
            if (verify.completed) {
              resolve({
                status: 200,
                responseText: JSON.stringify({ id: verify.videoId }),
                rangeHeader: null,
              });
              return;
            }
          } catch {}
        }
        reject(new Error('Network transmission interrupted'));
      };

      xhr.onabort = () => {
        if (stallTimer) clearTimeout(stallTimer);
        this.activeXhr = null;

        if (this.isCancelled) {
          reject(Object.assign(new Error('Upload cancelled'), { intentional: true }));
        } else if (this.isPaused) {
          reject(Object.assign(new Error('Transmission paused'), { intentional: true }));
        } else {
          reject(new Error('Transmission stalled (no bytes transferred for 30s)'));
        }
      };

      xhr.send(chunk);
    });
  }

  async getResumedOffset(): Promise<number> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.timeout = 15000;
      xhr.open('PUT', this.uploadUri, true);
      xhr.setRequestHeader('Content-Range', `bytes */${this.file.size}`);

      xhr.onload = () => {
        if (xhr.status === 200 || xhr.status === 201) {
          resolve(this.file.size);
          return;
        }

        if (xhr.status === 308) {
          const range = xhr.getResponseHeader('Range');
          if (range) {
            const match = range.match(/bytes=\d+-(\d+)/i);
            if (match && match[1]) {
              resolve(parseInt(match[1], 10) + 1);
              return;
            }
          }
        }
        resolve(0);
      };

      xhr.ontimeout = () => resolve(0);
      xhr.onerror = () => resolve(0);
      xhr.send();
    });
  }

  private async checkIfCompleted(retries = 3): Promise<{ completed: boolean; videoId: string }> {
    for (let i = 0; i < retries; i++) {
      const result = await new Promise<{ completed: boolean; videoId: string }>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = 15000;
        xhr.open('PUT', this.uploadUri, true);
        xhr.setRequestHeader('Content-Range', `bytes */${this.file.size}`);

        xhr.onload = () => {
          if (xhr.status === 200 || xhr.status === 201) {
            try {
              const json = JSON.parse(xhr.responseText);
              resolve({ completed: true, videoId: json.id || '' });
            } catch {
              resolve({ completed: true, videoId: '' });
            }
          } else {
            resolve({ completed: false, videoId: '' });
          }
        };

        xhr.ontimeout = () => resolve({ completed: false, videoId: '' });
        xhr.onerror = () => resolve({ completed: false, videoId: '' });
        xhr.send();
      });

      if (result.completed) return result;

      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1800));
      }
    }

    return { completed: false, videoId: '' };
  }

  private emitProgress(uploaded: number, speedMBps: number) {
    if (this.file.size <= 0) return;

    const safeUploaded = Math.min(uploaded, this.file.size);
    const percentage = safeUploaded === this.file.size
      ? 100
      : Math.min(99, Math.round((safeUploaded / this.file.size) * 100));

    this.onProgress({
      bytesUploaded: safeUploaded,
      totalBytes: this.file.size,
      percentage,
      speedMBps: Number(Math.max(0, speedMBps).toFixed(2)),
    });
  }

  /**
   * Targets an 8-second transfer window with a 2x growth limiter
   * to eliminate OS TCP socket buffer spike miscalculations.
   */
  private adaptChunkSize(uploadedBytes: number, durationSec: number) {
    if (durationSec <= 0 || uploadedBytes <= 0) return;

    const currentBytesPerSec = uploadedBytes / durationSec;
    const targetBytes = currentBytesPerSec * 8; // Optimal 8s window

    const maxAllowedGrowth = this.chunkSize * 2;
    const boundedTarget = Math.min(targetBytes, maxAllowedGrowth);

    const clamped = Math.max(this.minChunkSize, Math.min(boundedTarget, this.maxChunkSize));
    this.chunkSize = this.roundToChunkUnit(clamped);
  }

  private shrinkChunkSize() {
    const shrunk = Math.max(this.chunkSize / 2, this.minChunkSize);
    this.chunkSize = this.roundToChunkUnit(shrunk);
  }

  private roundToChunkUnit(bytes: number): number {
    const rounded = Math.floor(bytes / this.CHUNK_UNIT) * this.CHUNK_UNIT;
    return Math.max(rounded, this.CHUNK_UNIT);
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.isPaused) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  pause() {
    this.isPaused = true;
    if (this.activeXhr) this.activeXhr.abort();
  }

  resume() {
    this.isPaused = false;
  }

  cancel() {
    this.isCancelled = true;
    if (this.activeXhr) this.activeXhr.abort();
  }
}