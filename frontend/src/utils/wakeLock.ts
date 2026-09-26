let wakeLockSentinel: any = null;

export async function requestWakeLock(): Promise<void> {
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    try {
      if (!wakeLockSentinel) {
        wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
        console.log('Screen Wake Lock active: Sleep prevented during upload.');

        wakeLockSentinel.addEventListener('release', () => {
          console.log('Screen Wake Lock released.');
          wakeLockSentinel = null;
        });
      }
    } catch (err: any) {
      console.warn('Wake Lock request warning:', err.message);
    }
  }
}

export async function releaseWakeLock(): Promise<void> {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    } catch (err: any) {
      console.warn('Wake Lock release error:', err.message);
    }
  }
}