/**
 * Utilidades básicas para marcadores
 * Solo funciones esenciales: cálculo de bearing y distancia
 */

import maplibregl from 'maplibre-gl';

/**
 * Calcula el bearing (ángulo de dirección) entre dos puntos en grados (0-360°)
 * @param a - Punto inicial { lat, lng }
 * @param b - Punto final { lat, lng }
 * @returns Ángulo en grados (0-360°)
 */
export function getBearing(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLng = (b.lng - a.lng) * (Math.PI / 180);
  const lat1 = a.lat * (Math.PI / 180);
  const lat2 = b.lat * (Math.PI / 180);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  let bearing = Math.atan2(y, x);
  bearing = bearing * (180 / Math.PI);
  bearing = (bearing + 360) % 360;

  return bearing;
}

/**
 * Calcula la distancia entre dos puntos en metros
 * @param a - Punto 1 { lat, lng }
 * @param b - Punto 2 { lat, lng }
 * @returns Distancia en metros
 */
export function calculateDistance(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
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
 * Rota un marcador de MapLibre a un ángulo específico con transición mínima
 * @param marker - Marcador de MapLibre
 * @param angle - Ángulo en grados (0-360°)
 */
export function rotateMarker(
  marker: maplibregl.Marker,
  angle: number
): void {
  if (!marker) return;

  const element = marker.getElement();
  if (element) {
    // Rotación directa con transición mínima (0.1s linear)
    element.style.transform = `rotate(${angle}deg)`;
    element.style.transition = 'transform 0.1s linear';
  }
}
