import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { getDistance, getGreatCircleBearing, getCompassDirection, getRhumbLineBearing } from 'geolib';
import { SocketService } from './socket.service';
import { UserService } from './user.service';
import { CapacitorGpsService, CapacitorGeoPosition } from './capacitor-gps.service';

export interface GeoPosition {
  lat: number;
  lng: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class GeoService {
  private watchId: number | null = null;
  private capacitorWatchId: string | null = null;
  private currentPositionSubject = new BehaviorSubject<GeoPosition | null>(null);
  public currentPosition$: Observable<GeoPosition | null> = this.currentPositionSubject.asObservable();
  private lastSentPosition: { lat: number; lng: number } | null = null;
  private lastErrorTime: number = 0;
  private lastErrorCode: number | null = null;
  private readonly ERROR_THROTTLE_MS = 30000; // Solo mostrar el mismo error cada 30 segundos
  private usingCapacitor: boolean = false;
  private currentAccuracy: number = 999; // Para mostrar en UI
  private lastSpeed: number = 0; // Última velocidad registrada para optimización
  private updateInterval: number = 1000; // Intervalo base de actualización (1 segundo)
  // locationSendIntervalId - ELIMINADO (solo marcador local)
  private lastKnownPosition: GeoPosition | null = null; // Última posición conocida (solo para uso local)

  constructor(
    private socketService: SocketService,
    private userService: UserService,
    private capacitorGpsService: CapacitorGpsService
  ) {
    // Detectar cuando la app vuelve del background (reanudar)
    this.setupVisibilityChangeListener();
    // Detectar cambios de red
    this.setupNetworkChangeListener();
    // Enviar ubicación cuando el socket se conecta
    this.setupSocketConnectionListener();
  }

  /**
   * Inicia el seguimiento de ubicación en tiempo real (híbrido: Capacitor primero, luego fallback)
   * @param callback - Callback opcional para procesar coordenadas
   */
  async iniciarGPS(callback?: (position: GeoPosition) => void): Promise<void> {
    // Intentar Capacitor primero
    if (this.capacitorGpsService.isAvailable()) {
      console.log('📱 Usando Capacitor Geolocation para mejor precisión');
      this.usingCapacitor = true;
      
      this.capacitorWatchId = await this.capacitorGpsService.watchPositionCapacitor(
        (position: CapacitorGeoPosition) => {
          // Validar coordenadas antes de procesar
          if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lng)) {
            console.warn('⚠️ Posición GPS de Capacitor inválida, descartando', position);
            return;
          }

          const lat = position.lat;
          const lng = position.lng;

          // Rechazar coordenadas (0, 0)
          if (lat === 0 && lng === 0) {
            console.warn('⚠️ Posición GPS de Capacitor es (0, 0), descartando');
            return;
          }

          // Validar rangos
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            console.warn('⚠️ Posición GPS de Capacitor fuera de rango, descartando', { lat, lng });
            return;
          }

          // Sanitizar speed y heading para convertir undefined a null
          const speedValue = (position.speed !== undefined && position.speed !== null && Number.isFinite(position.speed)) ? position.speed : null;
          const headingValue = (position.heading !== undefined && position.heading !== null && Number.isFinite(position.heading)) ? position.heading : null;

          const geoPosition: GeoPosition = {
            lat,
            lng,
            accuracy: Number.isFinite(position.accuracy) ? position.accuracy : 999,
            speed: speedValue,
            heading: headingValue,
            timestamp: position.timestamp
          };

          this.currentAccuracy = geoPosition.accuracy;
          this.currentPositionSubject.next(geoPosition);
          this.lastKnownPosition = geoPosition; // Guardar para envío periódico
          
          if (callback) {
            callback(geoPosition);
          }
        }
      );
      
      // Iniciar intervalo de envío periódico (300ms)
      // startPeriodicLocationSend() - ELIMINADO (solo marcador local)

      if (this.capacitorWatchId) {
        return; // Capacitor funcionó, no usar fallback
      } else {
        // Capacitor falló, usar fallback
        console.log('⚠️ Capacitor falló, usando API navegador como fallback');
        this.usingCapacitor = false;
      }
    } else {
      console.log('🌐 Capacitor no disponible, usando API navegador');
      this.usingCapacitor = false;
    }

    // Fallback a API navegador
    this.startTrackingFallback(callback);
  }

  /**
   * Inicia el seguimiento de ubicación usando API navegador (fallback)
   */
  private startTrackingFallback(callback?: (position: GeoPosition) => void): void {
    if (this.watchId !== null) {
      console.warn('El seguimiento de ubicación ya está activo');
      return;
    }

    if (!navigator.geolocation) {
      console.error('Geolocalización no está soportada en este navegador');
      return;
    }

    // Configuración optimizada para máxima precisión GPS
    const options: PositionOptions = {
      enableHighAccuracy: true, // Forzar uso de GPS (no WiFi/red móvil)
      maximumAge: 0, // No usar posiciones en caché, siempre obtener posición fresca (mejor precisión)
      timeout: 30000 // Aumentado a 30 segundos para dar más tiempo al GPS
    };
    
    console.log('🔍 Iniciando seguimiento GPS con alta precisión (API navegador)...');

    this.watchId = navigator.geolocation.watchPosition(
      (position: GeolocationPosition) => {
        // Validar que position.coords exista y tenga datos válidos
        if (!position || !position.coords) {
          console.warn('⚠️ Posición GPS sin coordenadas, descartando');
          return;
        }

        // Validar que lat y lng sean números finitos
        if (!Number.isFinite(position.coords.latitude) || !Number.isFinite(position.coords.longitude)) {
          console.warn('⚠️ Coordenadas GPS inválidas (NaN o Infinity), descartando');
          return;
        }

        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        // Rechazar coordenadas (0, 0) - punto nulo
        if (lat === 0 && lng === 0) {
          console.warn('⚠️ Coordenadas GPS inválidas (0, 0), descartando');
          return;
        }

        // Validar rangos
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          console.warn('⚠️ Coordenadas GPS fuera de rango, descartando', { lat, lng });
          return;
        }

        // Reset error tracking cuando obtenemos una posición exitosa
        this.lastErrorTime = 0;
        this.lastErrorCode = null;
        
        const geoPosition: GeoPosition = {
          lat,
          lng,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : 999,
          speed: Number.isFinite(position.coords.speed) ? position.coords.speed : null,
          heading: Number.isFinite(position.coords.heading) ? position.coords.heading : null,
          timestamp: position.timestamp
        };

        // Optimización de batería: ajustar intervalo según velocidad
        const speed = geoPosition.speed || 0;
        this.optimizeUpdateInterval(speed);

        this.currentAccuracy = geoPosition.accuracy;
        this.currentPositionSubject.next(geoPosition);
        this.lastKnownPosition = geoPosition; // Guardar para envío periódico
        
        if (callback) {
          callback(geoPosition);
        }
      },
      (error: GeolocationPositionError) => {
        // Throttle de errores: solo mostrar el mismo error cada 30 segundos
        const now = Date.now();
        const shouldLogError = 
          this.lastErrorCode !== error.code || 
          (now - this.lastErrorTime) > this.ERROR_THROTTLE_MS;

        if (shouldLogError) {
          const errorMessages: Record<number, string> = {
            1: 'Permiso de geolocalización denegado',
            2: 'Ubicación no disponible',
            3: 'Timeout al obtener ubicación GPS (continuando en segundo plano)'
          };
          const errorMsg = errorMessages[error.code] || 'Error desconocido';
          // Para timeouts, usar console.debug para ser menos intrusivo
          if (error.code === 3) {
            console.debug(`ℹ️ ${errorMsg}`);
          } else {
            console.warn(`⚠️ Error de geolocalización (${errorMsg}):`, error.message || errorMsg);
          }
          this.lastErrorTime = now;
          this.lastErrorCode = error.code;
        }
        
        this.currentPositionSubject.next(null);
      },
      options
    );
    
    // Envío periódico de ubicación - ELIMINADO (solo marcador local)
  }
  
  /**
   * Inicia el intervalo para enviar ubicación - ELIMINADO (solo marcador local)
   */
  
  /**
   * Envía la ubicación real directamente - ELIMINADO (solo marcador local)
   */

  /**
   * Inicia el seguimiento de ubicación en tiempo real (método legacy, mantiene compatibilidad)
   */
  startTracking(): void {
    this.iniciarGPS();
  }

  /**
   * Detiene el seguimiento de ubicación
   */
  async stopTracking(): Promise<void> {
    // Limpieza de intervalo de envío - ELIMINADO (solo marcador local)
    
    if (this.usingCapacitor && this.capacitorWatchId) {
      await this.capacitorGpsService.clearWatch();
      this.capacitorWatchId = null;
    }
    
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    
    this.currentPositionSubject.next(null);
    this.usingCapacitor = false;
    this.lastKnownPosition = null;
  }

  /**
   * Obtiene la precisión GPS actual
   */
  getCurrentAccuracy(): number {
    return this.currentAccuracy;
  }

  /**
   * Verifica si está usando Capacitor
   */
  isUsingCapacitor(): boolean {
    return this.usingCapacitor;
  }

  /**
   * Optimiza el intervalo de actualización según la velocidad para ahorrar batería
   * Si velocidad < 1 km/h (0.28 m/s) → reducir a 3 segundos
   * Si velocidad >= 1 km/h → usar 1-1.5 segundos
   */
  private optimizeUpdateInterval(speed: number): void {
    const speedKmh = speed * 3.6; // Convertir m/s a km/h
    
    if (speedKmh < 1) {
      // Vehículo detenido o moviéndose muy lento: actualizar cada 3 segundos
      this.updateInterval = 3000;
    } else {
      // Vehículo en movimiento: actualizar cada 1-1.5 segundos
      // Más rápido = más frecuente (hasta 1 segundo)
      // Más lento = menos frecuente (hasta 1.5 segundos)
      if (speedKmh > 50) {
        this.updateInterval = 1000; // Alta velocidad: 1 segundo
      } else if (speedKmh > 20) {
        this.updateInterval = 1200; // Velocidad media: 1.2 segundos
      } else {
        this.updateInterval = 1500; // Velocidad baja: 1.5 segundos
      }
    }
    
    this.lastSpeed = speed;
  }

  /**
   * Obtiene el intervalo de actualización actual
   */
  getUpdateInterval(): number {
    return this.updateInterval;
  }

  /**
   * Obtiene la posición actual una sola vez (híbrido: Capacitor primero, luego fallback)
   */
  async getCurrentPosition(): Promise<GeoPosition> {
    // Intentar Capacitor primero
    if (this.capacitorGpsService.isAvailable()) {
      const capacitorPos = await this.capacitorGpsService.getCurrentPositionCapacitor();
      if (capacitorPos) {
        this.currentAccuracy = capacitorPos.accuracy;
        return {
          lat: capacitorPos.lat,
          lng: capacitorPos.lng,
          accuracy: capacitorPos.accuracy,
          speed: capacitorPos.speed !== undefined ? capacitorPos.speed : null,
          heading: capacitorPos.heading !== undefined ? capacitorPos.heading : null,
          timestamp: capacitorPos.timestamp
        };
      }
    }

    // Fallback a API navegador
    return this.getCurrentPositionFallback();
  }

  /**
   * Obtiene la posición actual usando API navegador (fallback)
   */
  private getCurrentPositionFallback(): Promise<GeoPosition> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocalización no está soportada'));
        return;
      }

      // Configuración optimizada para máxima precisión GPS
      const options: PositionOptions = {
        enableHighAccuracy: true, // Forzar uso de GPS (no WiFi/red móvil)
        maximumAge: 0, // No usar posiciones en caché, siempre obtener posición fresca (mejor precisión)
        timeout: 30000 // Aumentado a 30 segundos para dar más tiempo al GPS
      };
      
      console.log('🔍 Obteniendo posición GPS con alta precisión (API navegador)...');

      navigator.geolocation.getCurrentPosition(
        (position: GeolocationPosition) => {
          // Validar que position.coords exista y tenga datos válidos
          if (!position || !position.coords) {
            reject(new Error('Posición GPS sin coordenadas'));
            return;
          }

          // Validar que lat y lng sean números finitos
          if (!Number.isFinite(position.coords.latitude) || !Number.isFinite(position.coords.longitude)) {
            reject(new Error('Coordenadas GPS inválidas (NaN o Infinity)'));
            return;
          }

          const lat = position.coords.latitude;
          const lng = position.coords.longitude;

          // Rechazar coordenadas (0, 0) - punto nulo
          if (lat === 0 && lng === 0) {
            reject(new Error('Coordenadas GPS inválidas (0, 0)'));
            return;
          }

          // Validar rangos
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            reject(new Error('Coordenadas GPS fuera de rango válido'));
            return;
          }

          // Reset error tracking cuando obtenemos una posición exitosa
          this.lastErrorTime = 0;
          this.lastErrorCode = null;
          
          const geoPosition: GeoPosition = {
            lat,
            lng,
            accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : 999,
            speed: Number.isFinite(position.coords.speed) ? position.coords.speed : null,
            heading: Number.isFinite(position.coords.heading) ? position.coords.heading : null,
            timestamp: position.timestamp
          };
          resolve(geoPosition);
        },
        (error: GeolocationPositionError) => {
          // Throttle de errores: solo mostrar el mismo error cada 30 segundos
          const now = Date.now();
          const shouldLogError = 
            this.lastErrorCode !== error.code || 
            (now - this.lastErrorTime) > this.ERROR_THROTTLE_MS;

          if (shouldLogError) {
            const errorMessages: Record<number, string> = {
              1: 'Permiso de geolocalización denegado',
              2: 'Ubicación no disponible',
              3: 'Timeout al obtener ubicación GPS (continuando en segundo plano)'
            };
            const errorMsg = errorMessages[error.code] || 'Error desconocido';
            // Para timeouts, mostrar mensaje más silencioso
            if (error.code === 3) {
              console.debug(`ℹ️ ${errorMsg}`);
            } else {
              console.warn(`⚠️ Error al obtener posición (${errorMsg})`);
            }
          }
          
          this.lastErrorTime = now;
          this.lastErrorCode = error.code;
          
          reject(error);
        },
        options
      );
    });
  }

  /**
   * Calcula la distancia entre dos puntos en metros usando geolib
   */
  calcularDistancia(
    punto1: { lat: number; lng: number },
    punto2: { lat: number; lng: number }
  ): number {
    return getDistance(
      { latitude: punto1.lat, longitude: punto1.lng },
      { latitude: punto2.lat, longitude: punto2.lng }
    );
  }

  /**
   * Calcula el rumbo (bearing) entre dos puntos en grados usando geolib
   */
  calcularRumbo(
    punto1: { lat: number; lng: number },
    punto2: { lat: number; lng: number }
  ): number {
    return getGreatCircleBearing(
      { latitude: punto1.lat, longitude: punto1.lng },
      { latitude: punto2.lat, longitude: punto2.lng }
    );
  }

  /**
   * Obtiene la dirección de la brújula (N, NE, E, etc.) usando geolib
   */
  obtenerDireccionCompass(
    punto1: { lat: number; lng: number },
    punto2: { lat: number; lng: number }
  ): string {
    return getCompassDirection(
      { latitude: punto1.lat, longitude: punto1.lng },
      { latitude: punto2.lat, longitude: punto2.lng }
    );
  }

  /**
   * Valida si una coordenada es válida
   */
  validarCoordenada(lat: number, lng: number): boolean {
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  /**
   * Obtiene las coordenadas actuales (alias para compatibilidad)
   * Valida coordenadas antes de retornar
   */
  async getCurrentCoords(): Promise<{ lat: number; lng: number; speed: number; accuracy: number }> {
    const position = await this.getCurrentPosition();
    
    // Validar coordenadas antes de retornar
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) {
      throw new Error('Coordenadas GPS inválidas (NaN o Infinity)');
    }

    if (position.lat === 0 && position.lng === 0) {
      throw new Error('Coordenadas GPS nulas (0, 0)');
    }

    if (position.lat < -90 || position.lat > 90 || position.lng < -180 || position.lng > 180) {
      throw new Error('Coordenadas GPS fuera de rango válido');
    }

    // Asegurar que speed siempre sea un número
    const speedValue = (position.speed !== null && position.speed !== undefined && Number.isFinite(position.speed)) ? position.speed : 0;

    return {
      lat: position.lat,
      lng: position.lng,
      speed: speedValue,
      accuracy: Number.isFinite(position.accuracy) ? position.accuracy : 999
    };
  }

  /**
   * Envía la ubicación actual vía socket
   * Valida coordenadas antes de enviar
   */
  /**
   * Envía la ubicación actual al servidor - ELIMINADO (solo marcador local)
   */


  /**
   * Configura listener para cuando la app vuelve del background
   */
  private setupVisibilityChangeListener(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', async () => {
        if (!document.hidden) {
          // La app volvió al foreground - ELIMINADO envío de ubicación (solo marcador local)
          console.log('📱 App reanudada desde background');
        }
      });
    }
  }

  /**
   * Configura listener para cambios de red
   */
  private setupNetworkChangeListener(): void {
    if (typeof navigator !== 'undefined' && 'connection' in navigator) {
      const connection = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
      if (connection) {
        connection.addEventListener('change', async () => {
          console.log('🌐 Cambio de red detectado - ELIMINADO envío de ubicación (solo marcador local)');
        });
      }
    }

    // También escuchar eventos online/offline
    if (typeof window !== 'undefined') {
      window.addEventListener('online', async () => {
        console.log('🌐 Conexión restaurada - ELIMINADO envío de ubicación (solo marcador local)');
      });
    }
  }

  /**
   * Configura listener para cuando el socket se conecta
   */
  private setupSocketConnectionListener(): void {
    const socket = this.socketService.getSocket();
    socket.on('connect', async () => {
      console.log('🔌 Socket conectado - ELIMINADO envío de ubicación (solo marcador local)');
    });
  }
}

