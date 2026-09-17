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
  private chunkSize = 5 * 1024 * 1024; // 5MB chunks (multiple of 256KB)
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

      const response = await fetch(this.uploadUri, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${startByte}-${endByte - 1}/${this.file.size}`,
        },
        body: chunk,
      });

      if (response.status === 308) {
        const range = response.headers.get('Range');
        if (range) {
          startByte = parseInt(range.split('-')[1], 10) + 1;
        } else {
          startByte = endByte;
        }

        const duration = (Date.now() - startTime) / 1000;
        const speedMBps = chunk.size / (1024 * 1024) / (duration || 0.001);

        this.onProgress({
          bytesUploaded: startByte,
          totalBytes: this.file.size,
          percentage: Math.round((startByte / this.file.size) * 100),
          speedMBps: Number(speedMBps.toFixed(2)),
        });
      } else if (response.status === 200 || response.status === 201) {
        const json = await response.json();
        return { videoId: json.id };
      } else {
        throw new Error(`Upload failed with status code ${response.status}`);
      }
    }

    throw new Error('Upload terminated unexpectedly');
  }

  async getResumedOffset(): Promise<number> {
    const res = await fetch(this.uploadUri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${this.file.size}` },
    });

    if (res.status === 308) {
      const range = res.headers.get('Range');
      if (range) return parseInt(range.split('-')[1], 10) + 1;
    }
    return 0;
  }

  pause() { this.isPaused = true; }
  resume() { this.isPaused = false; }
  cancel() { this.isCancelled = true; }
}