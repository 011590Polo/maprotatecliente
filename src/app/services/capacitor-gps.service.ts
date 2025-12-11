/**
 * Servicio de Geolocalización usando Capacitor
 * Proporciona mejor precisión GPS en dispositivos móviles
 * Retorna null si Capacitor no está disponible (fallback a GeoService)
 */

import { Injectable } from '@angular/core';
import { Geolocation, Position, PositionOptions } from '@capacitor/geolocation';

export interface CapacitorGeoPosition {
  lat: number;
  lng: number;
  accuracy: number;
  speed?: number;
  heading?: number;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class CapacitorGpsService {
  private watchId: string | null = null;
  private isCapacitorAvailable: boolean = false;

  constructor() {
    // Verificar si Capacitor está disponible
    this.checkCapacitorAvailability();
  }

  /**
   * Verifica si Capacitor está disponible
   */
  private async checkCapacitorAvailability(): Promise<void> {
    try {
      // Intentar importar Capacitor
      const { Capacitor } = await import('@capacitor/core');
      this.isCapacitorAvailable = Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'web';
      
      // También verificar si Geolocation está disponible
      if (this.isCapacitorAvailable) {
        try {
          await Geolocation.checkPermissions();
          this.isCapacitorAvailable = true;
        } catch {
          this.isCapacitorAvailable = false;
        }
      }
    } catch (error) {
      console.debug('Capacitor no disponible, usando fallback a API navegador');
      this.isCapacitorAvailable = false;
    }
  }

  /**
   * Verifica si Capacitor está disponible
   */
  isAvailable(): boolean {
    return this.isCapacitorAvailable;
  }

  /**
   * Obtiene la posición actual usando Capacitor
   * @returns Posición GPS o null si falla
   */
  async getCurrentPositionCapacitor(): Promise<CapacitorGeoPosition | null> {
    try {
      // Verificar permisos primero
      let permissionStatus = await Geolocation.checkPermissions();
      
      if (permissionStatus.location !== 'granted') {
        console.log('📍 Solicitando permisos de ubicación precisa...');
        // Solicitar permisos de ubicación precisa
        permissionStatus = await Geolocation.requestPermissions();
        
        if (permissionStatus.location !== 'granted') {
          console.warn('⚠️ Permisos de geolocalización denegados. La precisión puede verse afectada.');
          return null;
        }
        
        console.log('✅ Permisos de ubicación precisa concedidos');
      } else {
        console.log('✅ Permisos de ubicación precisa ya concedidos');
      }

      // Configuración optimizada para máxima precisión GPS
      const options: PositionOptions = {
        enableHighAccuracy: true, // Forzar uso de GPS (no WiFi/red móvil)
        timeout: 30000, // Aumentado a 30 segundos para dar más tiempo al GPS
        maximumAge: 0 // No usar posiciones en caché, siempre obtener posición fresca
      };

      console.log('🔍 Obteniendo posición GPS con alta precisión...');
      const position: Position = await Geolocation.getCurrentPosition(options);
      
      if (position && position.coords) {
        console.log(`✅ Posición GPS obtenida - Precisión: ${position.coords.accuracy?.toFixed(1)}m`);
      }

      return this.convertCapacitorPosition(position);
    } catch (error: any) {
      console.warn('❌ Error al obtener posición con Capacitor:', error.message || error);
      return null;
    }
  }

  /**
   * Inicia el seguimiento de ubicación usando Capacitor
   * @param callback - Función que se ejecuta cuando hay una nueva posición
   * @returns ID del watch o null si falla
   */
  async watchPositionCapacitor(
    callback: (position: CapacitorGeoPosition) => void
  ): Promise<string | null> {
    try {
      // Verificar permisos primero
      let permissionStatus = await Geolocation.checkPermissions();
      
      if (permissionStatus.location !== 'granted') {
        console.log('📍 Solicitando permisos de ubicación precisa para seguimiento continuo...');
        // Solicitar permisos de ubicación precisa
        permissionStatus = await Geolocation.requestPermissions();
        
        if (permissionStatus.location !== 'granted') {
          console.warn('⚠️ Permisos de geolocalización denegados. El seguimiento no puede iniciarse.');
          return null;
        }
        
        console.log('✅ Permisos de ubicación precisa concedidos para seguimiento continuo');
      } else {
        console.log('✅ Permisos de ubicación precisa ya concedidos');
      }

      // Configuración optimizada para máxima precisión GPS en seguimiento continuo
      const options: PositionOptions = {
        enableHighAccuracy: true, // Forzar uso de GPS (no WiFi/red móvil)
        timeout: 30000, // Aumentado a 30 segundos para dar más tiempo al GPS
        maximumAge: 0 // No usar posiciones en caché, siempre obtener posición fresca
      };

      console.log('🔍 Iniciando seguimiento GPS con alta precisión...');
      this.watchId = await Geolocation.watchPosition(
        options,
        (position: Position | null, err?: any) => {
          if (err) {
            console.warn('⚠️ Error en watchPosition de Capacitor:', err.message || err);
            return;
          }

          if (position && position.coords) {
            const convertedPosition = this.convertCapacitorPosition(position);
            if (convertedPosition) {
              // Log de precisión solo ocasionalmente para no saturar la consola
              if (Math.random() < 0.1) { // 10% de las veces
                console.log(`📍 Posición GPS actualizada - Precisión: ${convertedPosition.accuracy.toFixed(1)}m`);
              }
              callback(convertedPosition);
            }
          }
        }
      );

      if (this.watchId) {
        console.log('✅ Seguimiento GPS iniciado correctamente');
      }

      return this.watchId;
    } catch (error: any) {
      console.warn('❌ Error al iniciar watchPosition con Capacitor:', error.message || error);
      return null;
    }
  }

  /**
   * Detiene el seguimiento de ubicación
   */
  async clearWatch(): Promise<void> {
    if (this.watchId) {
      try {
        await Geolocation.clearWatch({ id: this.watchId });
        this.watchId = null;
      } catch (error) {
        console.warn('Error al detener watchPosition de Capacitor:', error);
      }
    }
  }

  /**
   * Convierte una posición de Capacitor al formato estándar
   * Valida coordenadas estrictamente antes de retornar
   */
  private convertCapacitorPosition(position: Position): CapacitorGeoPosition | null {
    if (!position || !position.coords) {
      return null;
    }

    // Validar que lat y lng sean números finitos
    if (!Number.isFinite(position.coords.latitude) || !Number.isFinite(position.coords.longitude)) {
      console.warn('⚠️ Posición de Capacitor con coordenadas inválidas (NaN o Infinity)');
      return null;
    }

    const lat = position.coords.latitude;
    const lng = position.coords.longitude;

    // Rechazar coordenadas (0, 0)
    if (lat === 0 && lng === 0) {
      console.warn('⚠️ Posición de Capacitor con coordenadas nulas (0, 0)');
      return null;
    }

    // Validar rangos
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      console.warn('⚠️ Posición de Capacitor con coordenadas fuera de rango', { lat, lng });
      return null;
    }

    return {
      lat,
      lng,
      accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : 999,
      speed: (position.coords.speed !== null && Number.isFinite(position.coords.speed)) ? position.coords.speed : undefined,
      heading: (position.coords.heading !== null && Number.isFinite(position.coords.heading)) ? position.coords.heading : undefined,
      timestamp: position.timestamp || Date.now()
    };
  }
}

