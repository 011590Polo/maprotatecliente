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
  private lastErrorTime: number = 0;
  private lastErrorCode: number | null = null;
  private readonly ERROR_THROTTLE_MS = 30000; // Solo mostrar el mismo error cada 30 segundos
  private usingCapacitor: boolean = false;
  private currentAccuracy: number = 999; // Para mostrar en UI
  private lastSpeed: number = 0; // Última velocidad registrada para optimización
  private updateInterval: number = 1000; // Intervalo base de actualización (1 segundo)
  // Transmisión de ubicación para conductores
  private conductorLocationIntervalId: number | null = null; // Intervalo para enviar ubicación cada 300ms (solo conductores)
  private lastKnownPosition: GeoPosition | null = null; // Última posición conocida
  private lastSentPosition: GeoPosition | null = null; // Última posición enviada exitosamente
  private pendingPositions: GeoPosition[] = []; // Cola de posiciones pendientes cuando no hay conexión
  private isConductorActive: boolean = false; // Flag para saber si el conductor está activo
  private socketReconnectHandler?: () => void; // Handler para reconexión

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
          
          // PRINCIPIO RECTOR: Si es conductor activo, enviar inmediatamente (sin esperar intervalo)
          if (this.isConductorActive && this.conductorLocationIntervalId !== null) {
            // Enviar inmediatamente cuando hay nueva posición GPS válida
            // Esto garantiza transmisión continua y en tiempo real
            this.enviarUbicacionConductor(geoPosition);
          }
          
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

    // Configuración optimizada para MÁXIMA VELOCIDAD Y PRECISIÓN
    const options: PositionOptions = {
      enableHighAccuracy: true, // Forzar uso de GPS
      maximumAge: 0, // No usar posiciones en caché, siempre posición fresca
      timeout: 5000 // Timeout corto para respuesta rápida
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
        
        // PRINCIPIO RECTOR: Si es conductor activo, enviar inmediatamente (sin esperar intervalo)
        if (this.isConductorActive && this.conductorLocationIntervalId !== null) {
          // Enviar inmediatamente cuando hay nueva posición GPS válida
          // Esto garantiza transmisión continua y en tiempo real
          this.enviarUbicacionConductor(geoPosition);
        }
        
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
  /**
   * Verifica si el GPS está activo (watchPosition funcionando)
   */
  isTracking(): boolean {
    return this.watchId !== null || this.capacitorWatchId !== null;
  }

  async stopTracking(): Promise<void> {
    // Detener transmisión de conductor si está activa
    this.detenerTransmisionConductor();
    
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
        enableHighAccuracy: true, // Forzar uso de GPS
        maximumAge: 0, // No usar posiciones en caché, siempre posición fresca
        timeout: 5000 // Timeout corto para respuesta rápida
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
   * CRÍTICO: Reenvía última coordenada al reconectar si es conductor
   */
  private setupSocketConnectionListener(): void {
    const socket = this.socketService.getSocket();
    
    // Handler para reconexión - REENVÍO INMEDIATO de última coordenada
    this.socketReconnectHandler = () => {
      if (this.isConductorActive && this.lastKnownPosition) {
        console.log('🔄 Socket reconectado - Reenviando última coordenada válida del conductor');
        
        // Reenviar última coordenada válida inmediatamente
        if (this.lastKnownPosition) {
          this.enviarUbicacionConductor(this.lastKnownPosition);
        }
        
        // Procesar cola de posiciones pendientes
        if (this.pendingPositions.length > 0) {
          console.log(`📦 Procesando ${this.pendingPositions.length} coordenadas pendientes`);
          const positionsToSend = [...this.pendingPositions];
          this.pendingPositions = [];
          
          // Enviar todas las posiciones pendientes
          positionsToSend.forEach(pos => {
            this.enviarUbicacionConductor(pos);
          });
        }
      }
    };
    
    socket.on('connect', () => {
      console.log('🔌 Socket conectado');
      if (this.socketReconnectHandler) {
        this.socketReconnectHandler();
      }
    });
    
    // Escuchar eventos de reconexión personalizados
    window.addEventListener('socket-reconnected', () => {
      if (this.socketReconnectHandler) {
        this.socketReconnectHandler();
      }
    });
  }

  /**
   * Inicia la transmisión de ubicación para conductores
   * PRINCIPIO RECTOR: Transmitir SIEMPRE cuando hay coordenada válida
   * Solo funciona si el usuario tiene rol 'conductor'
   */
  iniciarTransmisionConductor(): void {
    console.log('🚗 Iniciando transmisión de ubicación para conductor');
    
    // Marcar conductor como activo
    this.isConductorActive = true;
    console.log('✅ Flag isConductorActive = true');
    
    // Detener intervalo anterior si existe
    if (this.conductorLocationIntervalId !== null) {
      clearInterval(this.conductorLocationIntervalId);
      console.log('🛑 Intervalo anterior detenido');
    }
    
    // Limpiar cola de posiciones pendientes
    this.pendingPositions = [];
    
    // Verificar que el GPS esté activo
    if (!this.isTracking()) {
      console.warn('⚠️ GPS no está activo - Activando GPS automáticamente');
      this.iniciarGPS().catch(error => {
        console.error('❌ Error al activar GPS:', error);
      });
    } else {
      console.log('✅ GPS ya está activo');
    }
    
    // Verificar socket conectado
    const socket = this.socketService.getSocket();
    if (!socket || !socket.connected) {
      console.warn('⚠️ Socket no conectado - La transmisión se reanudará al reconectar');
    } else {
      console.log('✅ Socket conectado - Listo para transmitir');
    }
    
    // OPTIMIZACIÓN: Enviar inmediatamente cuando se recibe nueva posición GPS
    // El envío se hará directamente en el callback de watchPosition
    
    // También mantener un intervalo como fallback para asegurar transmisión continua
    // incluso si el GPS no emite nuevas posiciones
    let lastSentTimestamp = 0;
    this.conductorLocationIntervalId = window.setInterval(() => {
      if (!this.isConductorActive) {
        return; // Conductor desactivado
      }
      
      if (!this.lastKnownPosition) {
        return; // No hay posición conocida aún
      }

      const currentPos = this.lastKnownPosition;
      const now = Date.now();
      
      // Enviar si han pasado al menos 50ms desde el último envío (máximo 20 updates/segundo)
      // O si la posición cambió significativamente
      const shouldSend = 
        (now - lastSentTimestamp >= 50) ||
        (!this.lastSentPosition || 
         Math.abs(currentPos.lat - this.lastSentPosition.lat) > 0.0001 ||
         Math.abs(currentPos.lng - this.lastSentPosition.lng) > 0.0001);
      
      if (shouldSend) {
        console.log('📡 Enviando ubicación desde intervalo fallback');
        this.enviarUbicacionConductor(currentPos);
        lastSentTimestamp = now;
      }
    }, 50); // Intervalo mínimo de 50ms (20 updates/segundo máximo)
    
    console.log('✅ Intervalo de transmisión iniciado (50ms)');
    
    // Si ya hay una posición conocida, enviarla inmediatamente
    if (this.lastKnownPosition) {
      console.log('📡 Enviando posición inicial del conductor:', this.lastKnownPosition);
      this.enviarUbicacionConductor(this.lastKnownPosition);
    } else {
      console.warn('⚠️ No hay posición conocida aún - Esperando primera posición GPS');
    }
  }

  /**
   * Detiene la transmisión de ubicación para conductores
   * IMPORTANTE: NO detiene el GPS (watchPosition), solo la transmisión
   */
  detenerTransmisionConductor(): void {
    console.log('🛑 Deteniendo transmisión de ubicación para conductor');
    
    // Marcar conductor como inactivo
    this.isConductorActive = false;
    
    // Detener intervalo de transmisión
    if (this.conductorLocationIntervalId !== null) {
      clearInterval(this.conductorLocationIntervalId);
      this.conductorLocationIntervalId = null;
    }
    
    // Limpiar cola de posiciones pendientes
    this.pendingPositions = [];
    
    // NOTA: NO detenemos watchPosition - el GPS sigue funcionando
    // para que cuando vuelva la conexión, podamos reanudar la transmisión
  }

  /**
   * Envía la ubicación del conductor al servidor
   * Con validación estricta para evitar enviar coordenadas inválidas
   */
  private async enviarUbicacionConductor(position: GeoPosition): Promise<void> {
    try {
      // VALIDACIÓN ESTRICTA - CAPA 1: Existencia
      if (!position) {
        console.warn('⚠️ No se envía ubicación de conductor: position es null/undefined');
        return;
      }

      // CAPA 2: Existencia de coordenadas
      if (position.lat === undefined || position.lat === null || position.lng === undefined || position.lng === null) {
        console.warn('⚠️ No se envía ubicación de conductor: lat o lng faltantes', position);
        return;
      }

      // CAPA 3: Tipo de dato
      if (typeof position.lat !== 'number' || typeof position.lng !== 'number') {
        console.warn('⚠️ No se envía ubicación de conductor: lat o lng no son números', { lat: position.lat, lng: position.lng, tipoLat: typeof position.lat, tipoLng: typeof position.lng });
        return;
      }

      // CAPA 4: Números finitos
      if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) {
        console.warn('⚠️ No se envía ubicación de conductor: coordenadas inválidas (NaN o Infinity)', { lat: position.lat, lng: position.lng });
        return;
      }

      // CAPA 5: Punto nulo
      if (position.lat === 0 && position.lng === 0) {
        console.warn('⚠️ No se envía ubicación de conductor: coordenadas nulas (0, 0)');
        return;
      }

      // CAPA 6: Rangos válidos
      if (position.lat < -90 || position.lat > 90 || position.lng < -180 || position.lng > 180) {
        console.warn('⚠️ No se envía ubicación de conductor: coordenadas fuera de rango', { lat: position.lat, lng: position.lng });
        return;
      }

      // CAPA 7: Validar accuracy si existe
      if (position.accuracy !== undefined && position.accuracy !== null) {
        if (!Number.isFinite(position.accuracy) || position.accuracy > 200) {
          console.warn('⚠️ No se envía ubicación de conductor: precisión GPS muy baja (>200m)', { accuracy: position.accuracy });
          return;
        }
      }

      // Preparar valores finales con conversión explícita
      const finalLat = Number(position.lat);
      const finalLng = Number(position.lng);
      const finalSpeed = (position.speed !== undefined && position.speed !== null && Number.isFinite(position.speed)) ? Number(position.speed) : 0;
      const finalAccuracy = (position.accuracy !== undefined && position.accuracy !== null && Number.isFinite(position.accuracy)) ? Number(position.accuracy) : null;

      // VALIDACIÓN FINAL antes de enviar
      if (!Number.isFinite(finalLat) || !Number.isFinite(finalLng)) {
        console.error('❌ ERROR CRÍTICO: Coordenadas no finitas después de validación', { finalLat, finalLng });
        return;
      }

      const userId = await this.userService.getUserId();
      const socket = this.socketService.getSocket();

      // Verificar que el conductor esté activo
      if (!this.isConductorActive) {
        console.warn('⚠️ No se envía ubicación: conductor no está activo');
        return;
      }

      // PRINCIPIO RECTOR: Si no hay conexión, guardar en cola para enviar después
      if (!socket) {
        console.warn('⚠️ Socket no disponible - Guardando coordenada en cola');
        if (this.pendingPositions.length < 10) {
          this.pendingPositions.push(position);
        } else {
          this.pendingPositions.shift();
          this.pendingPositions.push(position);
        }
        return;
      }
      
      if (!socket.connected) {
        console.warn('⚠️ Socket no conectado - Guardando coordenada en cola para enviar después');
        
        // Guardar en cola de posiciones pendientes (máximo 10 para no saturar memoria)
        if (this.pendingPositions.length < 10) {
          this.pendingPositions.push(position);
        } else {
          // Si la cola está llena, reemplazar la más antigua con la nueva
          this.pendingPositions.shift();
          this.pendingPositions.push(position);
        }
        
        return; // No intentar enviar si no hay conexión
      }
      
      console.log('📤 Enviando ubicación de conductor al servidor:', {
        lat: finalLat,
        lng: finalLng,
        accuracy: finalAccuracy,
        speed: finalSpeed,
        socketConnected: socket.connected
      });

      // INTENTAR ENVÍO - Si falla, se guardará en cola automáticamente
      try {
        // Enviar con valores validados y convertidos explícitamente
        socket.emit('ubicacion-conductor', {
          userId: userId || null,
          lat: finalLat,
          lng: finalLng,
          speed: finalSpeed,
          accuracy: finalAccuracy,
          timestamp: Date.now()
        });
        
        // Si llegamos aquí, el envío fue exitoso
        this.lastSentPosition = position;
        console.log('✅ Ubicación de conductor enviada exitosamente');
        
        // Remover de cola de pendientes si estaba ahí
        const indexInQueue = this.pendingPositions.findIndex(
          p => p.lat === position.lat && p.lng === position.lng
        );
        if (indexInQueue !== -1) {
          this.pendingPositions.splice(indexInQueue, 1);
        }
        
      } catch (error) {
        console.error('❌ Error al emitir ubicación de conductor:', error);
        
        // Si falla el envío, guardar en cola
        if (this.pendingPositions.length < 10) {
          this.pendingPositions.push(position);
        } else {
          this.pendingPositions.shift();
          this.pendingPositions.push(position);
        }
      }
    } catch (error) {
      console.error('❌ Error al enviar ubicación de conductor:', error);
    }
  }
}

