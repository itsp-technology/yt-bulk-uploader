// frontend/src/utils/chunkUploader.ts

export interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  speedMBps: number;
}

export class ResumableChunkUploader {
  private file: File;
  private uploadUri: string;
  // Use 10MB chunk size (must be a multiple of 256 KiB = 262144 bytes)
  private chunkSize = 10 * 1024 * 1024;
  private isPaused = false;
  private isCancelled = false;
  private onProgress: (p: UploadProgress) => void;

  constructor(file: File, uploadUri: string, onProgress: (p: UploadProgress) => void) {
    this.file = file;
    this.uploadUri = uploadUri;
    this.onProgress = onProgress;
  }

  async start(): Promise<{ videoId: string }> {
    let startByte = await this.getResumedOffset();

    while (startByte < this.file.size) {
      if (this.isCancelled) throw new Error('Upload cancelled');
      while (this.isPaused) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const endByte = Math.min(startByte + this.chunkSize, this.file.size);
      const chunk = this.file.slice(startByte, endByte);
      const startTime = Date.now();

      let attempts = 0;
      let success = false;
      let response: Response | null = null;

      // Retry each individual chunk up to 4 times with backoff if network blips
      while (!success && attempts < 4) {
        try {
          attempts++;
          response = await fetch(this.uploadUri, {
            method: 'PUT',
            headers: {
              'Content-Range': `bytes ${startByte}-${endByte - 1}/${this.file.size}`,
            },
            body: chunk,
          });

          // 308 (Resume Incomplete) or 200/201 (Completed)
          if (response.status === 308 || response.status === 200 || response.status === 201) {
            success = true;
          } else if (response.status >= 500) {
            // Server error on Google's end: wait and retry
            await new Promise((r) => setTimeout(r, attempts * 1500));
          } else {
            const errBody = await response.text();
            throw new Error(`Upload rejected with status ${response.status}: ${errBody}`);
          }
        } catch (netErr) {
          if (attempts >= 4) throw netErr;
          await new Promise((r) => setTimeout(r, attempts * 1500));
        }
      }

      if (!response) {
        throw new Error('No response received from YouTube upload endpoint.');
      }

      // Check if YouTube finished receiving the full video
      if (response.status === 200 || response.status === 201) {
        const json = await response.json();
        this.onProgress({
          bytesUploaded: this.file.size,
          totalBytes: this.file.size,
          percentage: 100,
          speedMBps: 0,
        });
        return { videoId: json.id };
      }

      // Handle intermediate 308 response
      if (response.status === 308) {
        const range = response.headers.get('Range');
        if (range) {
          const parts = range.split('-');
          startByte = parseInt(parts[1], 10) + 1;
        } else {
          startByte = endByte;
        }

        const elapsedSec = (Date.now() - startTime) / 1000;
        const speedMBps = chunk.size / (1024 * 1024) / (elapsedSec || 0.001);

        this.onProgress({
          bytesUploaded: startByte,
          totalBytes: this.file.size,
          percentage: Math.min(99, Math.round((startByte / this.file.size) * 100)),
          speedMBps: Number(speedMBps.toFixed(2)),
        });
      }
    }

    // Secondary check: query Google for status if loop finished without explicit 200
    const finalCheck = await fetch(this.uploadUri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${this.file.size}` },
    });

    if (finalCheck.status === 200 || finalCheck.status === 201) {
      const data = await finalCheck.json();
      return { videoId: data.id };
    }

    throw new Error(`Upload ended without a valid 200 confirmation (HTTP ${finalCheck.status})`);
  }

  async getResumedOffset(): Promise<number> {
    try {
      const res = await fetch(this.uploadUri, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes */${this.file.size}` },
      });

      if (res.status === 308) {
        const range = res.headers.get('Range');
        if (range) {
          const parts = range.split('-');
          return parseInt(parts[1], 10) + 1;
        }
      }
      return 0;
    } catch {
      return 0;
    }
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
  }

  cancel() {
    this.isCancelled = true;
  }
}