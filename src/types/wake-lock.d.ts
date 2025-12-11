/**
 * Declaración de tipos para la API de Wake Lock
 * Compatible con navegadores modernos (Chrome Android, Safari iOS 16.4+)
 */

interface WakeLockSentinel extends EventTarget {
  readonly released: boolean;
  readonly type: 'screen';
  release(): Promise<void>;
}

interface WakeLock {
  request(type: 'screen'): Promise<WakeLockSentinel>;
}

interface Navigator {
  wakeLock?: WakeLock;
}


