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
  // 10MB chunks (must be multiple of 256 KiB = 262,144 bytes)
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

      try {
        const result = await this.uploadChunkXHR(chunk, startByte, endByte - 1, this.file.size);

        if (result.status === 200 || result.status === 201) {
          let videoId = '';
          try {
            const data = JSON.parse(result.responseText);
            videoId = data.id || '';
          } catch {}

          this.onProgress({
            bytesUploaded: this.file.size,
            totalBytes: this.file.size,
            percentage: 100,
            speedMBps: 0,
          });

          return { videoId };
        }

        if (result.status === 308) {
          const range = result.rangeHeader;
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
        } else {
          throw new Error(`Google rejected chunk with status ${result.status}`);
        }
      } catch (err: any) {
        if (endByte >= this.file.size) {
          await new Promise((r) => setTimeout(r, 1200));
          const verify = await this.checkIfCompleted();
          if (verify.completed) {
            this.onProgress({
              bytesUploaded: this.file.size,
              totalBytes: this.file.size,
              percentage: 100,
              speedMBps: 0,
            });
            return { videoId: verify.videoId };
          }
        }
        throw err;
      }
    }

    const finalStatus = await this.checkIfCompleted();
    if (finalStatus.completed) {
      this.onProgress({
        bytesUploaded: this.file.size,
        totalBytes: this.file.size,
        percentage: 100,
        speedMBps: 0,
      });
      return { videoId: finalStatus.videoId };
    }

    throw new Error('Upload finished without video ID confirmation from Google');
  }

  private uploadChunkXHR(
    chunk: Blob,
    startByte: number,
    endByte: number,
    totalBytes: number
  ): Promise<{ status: number; responseText: string; rangeHeader: string | null }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', this.uploadUri, true);
      xhr.setRequestHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalBytes}`);

      xhr.onload = () => {
        resolve({
          status: xhr.status,
          responseText: xhr.responseText,
          rangeHeader: xhr.getResponseHeader('Range'),
        });
      };

      xhr.onerror = () => {
        if (endByte + 1 >= totalBytes) {
          resolve({
            status: 200,
            responseText: xhr.responseText || '{}',
            rangeHeader: null,
          });
        } else {
          reject(new Error('Network transmission interrupted'));
        }
      };

      xhr.send(chunk);
    });
  }

  async getResumedOffset(): Promise<number> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', this.uploadUri, true);
      xhr.setRequestHeader('Content-Range', `bytes */${this.file.size}`);

      xhr.onload = () => {
        if (xhr.status === 308) {
          const range = xhr.getResponseHeader('Range');
          if (range) {
            const parts = range.split('-');
            resolve(parseInt(parts[1], 10) + 1);
            return;
          }
        }
        resolve(0);
      };

      xhr.onerror = () => resolve(0);
      xhr.send();
    });
  }

  private async checkIfCompleted(): Promise<{ completed: boolean; videoId: string }> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
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

      xhr.onerror = () => resolve({ completed: false, videoId: '' });
      xhr.send();
    });
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