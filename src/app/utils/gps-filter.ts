/**
 * Utilidades para filtrado y mejora de precisión GPS
 * Especialmente optimizado para dispositivos móviles
 */

export interface GPSPosition {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
  speed?: number | null;
  heading?: number | null;
}

/**
 * Historial de posiciones GPS para filtrado
 */
interface GPSHistory {
  positions: GPSPosition[];
  maxHistorySize: number;
  lastValidPosition: GPSPosition | null;
}

/**
 * Filtro de suavizado GPS usando promedio móvil y validación de precisión
 */
export class GPSFilter {
  private history: GPSHistory = {
    positions: [],
    maxHistorySize: 5, // Mantener últimas 5 posiciones para promedio (se ajusta para móviles)
    lastValidPosition: null
  };

  private MAX_ACCURACY = 50; // Máximo 50 metros de precisión aceptable (ajustable)
  private readonly MIN_DISTANCE_FOR_UPDATE = 2; // Mínimo 2 metros para actualizar
  private readonly MAX_JUMP_DISTANCE = 100; // Máximo 100 metros de salto (rechaza saltos GPS erróneos)
  private readonly MAX_SPEED_MS = 50; // Máximo 50 m/s (180 km/h) - velocidad razonable para vehículos
  private readonly MOBILE_MAX_ACCURACY = 25; // Para móviles, máximo 25m (más estricto para mantener en calle)
  private readonly MOBILE_HISTORY_SIZE = 7; // Más posiciones en historial para móviles (mejor suavizado)

  /**
   * Filtra y suaviza una posición GPS
   * @param position - Posición GPS nueva
   * @returns Posición filtrada y suavizada, o null si se rechaza
   */
  filterPosition(position: GPSPosition): GPSPosition | null {
    // Detectar si es dispositivo móvil (precisión típicamente mejor en móviles)
    const isMobile = this.isMobileDevice();
    const maxAccuracy = isMobile ? this.MOBILE_MAX_ACCURACY : this.MAX_ACCURACY;
    
    // Ajustar tamaño de historial para móviles (mejor suavizado)
    if (isMobile && this.history.maxHistorySize < this.MOBILE_HISTORY_SIZE) {
      this.history.maxHistorySize = this.MOBILE_HISTORY_SIZE;
    }
    
    // 1. Validar precisión GPS (más estricto en móviles)
    if (position.accuracy > maxAccuracy) {
      console.debug(`📍 Posición GPS rechazada por baja precisión: ${position.accuracy.toFixed(1)}m (máximo: ${maxAccuracy}m)`);
      // Si hay una posición válida anterior, mantenerla
      return this.history.lastValidPosition;
    }

    // 2. Validar que la posición sea razonable (no saltos GPS)
    if (this.history.lastValidPosition) {
      const distance = this.calculateDistance(
        this.history.lastValidPosition,
        position
      );

      // Rechazar saltos GPS muy grandes (probablemente error)
      if (distance > this.MAX_JUMP_DISTANCE) {
        console.warn(`📍 Salto GPS rechazado: ${distance.toFixed(1)}m (máximo: ${this.MAX_JUMP_DISTANCE}m)`);
        return this.history.lastValidPosition;
      }

      // Validar velocidad razonable
      const timeDelta = (position.timestamp - this.history.lastValidPosition.timestamp) / 1000; // segundos
      if (timeDelta > 0) {
        const calculatedSpeed = distance / timeDelta; // m/s
        if (calculatedSpeed > this.MAX_SPEED_MS) {
          console.warn(`📍 Posición GPS rechazada por velocidad irreal: ${(calculatedSpeed * 3.6).toFixed(1)} km/h`);
          return this.history.lastValidPosition;
        }
      }
    }

    // 3. Agregar a historial
    this.history.positions.push(position);
    if (this.history.positions.length > this.history.maxHistorySize) {
      this.history.positions.shift(); // Remover la más antigua
    }

    // 4. Calcular promedio móvil ponderado (más peso a posiciones recientes y precisas)
    const smoothedPosition = this.calculateWeightedAverage();

    // 5. Actualizar última posición válida
    this.history.lastValidPosition = smoothedPosition;

    return smoothedPosition;
  }

  /**
   * Calcula promedio móvil ponderado de las posiciones en el historial
   * Da más peso a posiciones más recientes y más precisas
   */
  private calculateWeightedAverage(): GPSPosition {
    if (this.history.positions.length === 0) {
      throw new Error('No hay posiciones en el historial');
    }

    if (this.history.positions.length === 1) {
      return this.history.positions[0];
    }

    let totalWeight = 0;
    let weightedLat = 0;
    let weightedLng = 0;
    let maxAccuracy = 0;
    let latestTimestamp = 0;
    let avgSpeed = 0;
    let avgHeading = 0;
    let headingCount = 0; // Contador para calcular promedio de heading

    // Calcular pesos: más peso = más reciente + más precisa
    this.history.positions.forEach((pos, index) => {
      // Peso por recencia (más reciente = más peso)
      const recencyWeight = (index + 1) / this.history.positions.length;
      
      // Peso por precisión (más precisa = más peso)
      // Invertir accuracy: menor accuracy = mayor peso
      const accuracyWeight = 1 / (1 + pos.accuracy / 10);
      
      // Peso combinado
      const weight = recencyWeight * accuracyWeight;
      
      weightedLat += pos.lat * weight;
      weightedLng += pos.lng * weight;
      totalWeight += weight;
      
      // Actualizar valores máximos/mínimos
      if (pos.accuracy > maxAccuracy) maxAccuracy = pos.accuracy;
      if (pos.timestamp > latestTimestamp) latestTimestamp = pos.timestamp;
      if (pos.speed) avgSpeed += pos.speed;
      if (pos.heading !== undefined && pos.heading !== null && !isNaN(pos.heading)) {
        avgHeading += pos.heading;
        headingCount++;
      }
    });

    // Calcular promedios
    const avgLat = weightedLat / totalWeight;
    const avgLng = weightedLng / totalWeight;
    avgSpeed = avgSpeed / this.history.positions.length;
    avgHeading = headingCount > 0 ? avgHeading / headingCount : 0;

    // Usar la precisión de la posición más reciente (más conservador)
    const latestPos = this.history.positions[this.history.positions.length - 1];

    return {
      lat: avgLat,
      lng: avgLng,
      accuracy: latestPos.accuracy,
      timestamp: latestTimestamp || latestPos.timestamp,
      speed: avgSpeed > 0 ? avgSpeed : latestPos.speed,
      heading: headingCount > 0 ? avgHeading : (latestPos.heading !== undefined && latestPos.heading !== null ? latestPos.heading : undefined)
    };
  }

  /**
   * Calcula la distancia entre dos posiciones en metros
   */
  private calculateDistance(
    a: GPSPosition,
    b: GPSPosition
  ): number {
    const R = 6371000; // Radio de la Tierra en metros
    const dLat = (b.lat - a.lat) * (Math.PI / 180);
    const dLng = (b.lng - a.lng) * (Math.PI / 180);
    const lat1 = a.lat * (Math.PI / 180);
    const lat2 = b.lat * (Math.PI / 180);

    const a_val =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLng / 2) *
        Math.sin(dLng / 2) *
        Math.cos(lat1) *
        Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a_val), Math.sqrt(1 - a_val));

    return R * c;
  }

  /**
   * Obtiene la última posición válida
   */
  getLastValidPosition(): GPSPosition | null {
    return this.history.lastValidPosition;
  }

  /**
   * Limpia el historial (útil cuando se reinicia el tracking)
   */
  clearHistory(): void {
    this.history.positions = [];
    this.history.lastValidPosition = null;
  }

  /**
   * Ajusta la precisión máxima aceptable
   */
  setMaxAccuracy(maxAccuracy: number): void {
    this.MAX_ACCURACY = maxAccuracy;
  }

  /**
   * Detecta si es un dispositivo móvil
   */
  private isMobileDevice(): boolean {
    if (typeof window === 'undefined') return false;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }
}

