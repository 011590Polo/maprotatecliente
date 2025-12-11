import { AfterViewInit, Component, OnDestroy, ChangeDetectorRef } from '@angular/core';
import maplibregl, { Map as MapLibreMap, Marker, Popup, NavigationControl, GeolocateControl } from 'maplibre-gl';
import { SpeedDialComponent } from '../speed-dial/speed-dial.component';
import { NotificationsPanelComponent } from '../notifications-panel/notifications-panel.component';
import { NgIf, NgFor } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GeoService, GeoPosition } from '../services/geo.service';
import { ApiService, Marcador } from '../services/api.service';
import { SocketService } from '../services/socket.service';
import { NotificationService } from '../services/notification.service';
import { UserService } from '../services/user.service';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  getBearing,
  rotateMarker,
  calculateDistance
} from '../utils/marker-utils';

@Component({
  selector: 'app-map-view',
  standalone: true,
  imports: [SpeedDialComponent, NotificationsPanelComponent, NgIf, NgFor, FormsModule],
  templateUrl: './map-view.component.html',
  styleUrl: './map-view.component.css'
})
export class MapViewComponent implements AfterViewInit, OnDestroy {
  private map?: MapLibreMap;
  private baseLayers: Record<string, string> = {
    // CartoDB Voyager como default - soporta CORS (estilo similar a OSM)
    osmStandard: 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    osmHot: 'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    // Reemplazado OpenTopoMap (no soporta CORS, error 404) con CartoDB Voyager sin etiquetas
    // Esta capa ofrece un estilo más limpio sin etiquetas de calles
    osmTopo: 'https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
    cartoPositron: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    cartoDark: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  };
  private currentBaseKey: string = 'osmStandard';
  private routeSourceId: string = 'route-source';
  private routeLayerId: string = 'route-layer';

  // Búsqueda de direcciones
  searchQuery: string = '';
  searchResultValid: boolean | null = null;
  searchInProgress: boolean = false;
  searchError: string | null = null;
  searchResults: { displayName: string; lat: number; lon: number }[] = [];
  private searchMarker?: Marker;
  private searchTimeout: any;
  searchBarVisible: boolean = false; // Controla la visibilidad de la barra de búsqueda

  // Geolocalización
  private userLocationMarker?: Marker;
  private geoSubscription?: Subscription;
  private smoothMoveAnimation?: number;
  private hasInitializedDraggable: boolean = false;
  private mapCenteredOnce: boolean = false;

  // Modal de marcador
  modalMarcadorAbierto: boolean = false;
  selectedCategory: 'alerta' | 'peligro' | 'informacion' = 'alerta';
  descripcionMarcador: string = '';
  archivoSeleccionado?: File;
  coordenadasMarcador?: { lat: number; lng: number };

  // Modal de gestión de marcadores
  modalGestionMarcadoresAbierto: boolean = false;
  marcadoresGuardados: Marcador[] = [];
  marcadorEditando?: Marcador;
  modalEditarMarcadorAbierto: boolean = false;
  cargandoMarcadores: boolean = false;

  // Modal de imagen en grande
  selectedImage: string | null = null;
  showImageModal: boolean = false;

  // Sistema de alertas DaisyUI
  alertaVisible: boolean = false;
  alertaMensaje: string = '';
  alertaTipo: 'success' | 'error' | 'warning' | 'info' = 'info';

  // Sistema de loading global
  loadingVisible: boolean = false;
  loadingMensaje: string = 'Cargando...';

  // Modal de video
  modalVideoAbierto: boolean = false;
  videoUrlActual: string | null = null;

  // Modal de GPS
  modalGPSAbierto: boolean = false;
  gpsPermisoDenegado: boolean = false;
  mensajeGPS: string = 'Por favor, para conocer todos los lugares del mundo es necesario que actives el GPS.';
  verificandoGPS: boolean = false;
  gpsValidado: boolean = false; // Flag para evitar validaciones repetidas
  currentAccuracy: number | undefined = undefined; // Precisión GPS actual para mostrar en UI

  // Modal de Login
  modalLoginAbierto: boolean = false;
  loginUsuario: string = '';
  loginClave: string = '';
  loginError: string = '';
  loginCargando: boolean = false;

  // Usuario logueado
  usuarioLogueado: { id: number; usuario: string; rol: string; estado: string } | null = null;

  // Sistema de notificaciones
  notificationsPanelVisible: boolean = false;
  unreadNotificationsCount: number = 0;
  // No necesitamos lastLocationNotification ya que no notificamos nuestra propia ubicación

  // Marcadores guardados
  private savedMarkers: Marker[] = [];
  private readonly categoryIcons: Record<string, HTMLElement> = {};

  // Marcadores de usuarios en tiempo real - ELIMINADO (solo marcador local)

  // Suscripciones de socket para tiempo real
  private socketSubscriptions: Subscription[] = [];
  private socketListenersInicializados: boolean = false;

  // Wake Lock para evitar que la pantalla se apague en móviles
  private wakeLock: WakeLockSentinel | null = null;

  // Listener para eventos personalizados desde popups
  private imagePopupListener?: (event: any) => void;
  
  // Botón para resetear rotación
  resetRotationButton?: HTMLButtonElement;

  constructor(
    private geoService: GeoService,
    private apiService: ApiService,
    private socketService: SocketService,
    private notificationService: NotificationService,
    private userService: UserService,
    private cdr: ChangeDetectorRef
  ) {
    // Crear elementos HTML para iconos de categorías
    this.categoryIcons = {
      'alerta': this.createCategoryIcon('#fbbf24', '⚠'),
      'peligro': this.createCategoryIcon('#ef4444', '🔥'),
      'informacion': this.createCategoryIcon('#3b82f6', 'ℹ'),
    };

    // Iconos de usuarios - ELIMINADO (solo marcador local)
  }

  /**
   * Crea un elemento HTML para icono de categoría
   */
  private createCategoryIcon(color: string, emoji: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'custom-marker';
    el.innerHTML = `
      <div style="background-color: ${color}; width: 30px; height: 30px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); border: 3px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">
        <div style="transform: rotate(45deg); color: white; font-size: 18px; text-align: center; line-height: 24px; font-weight: bold;">${emoji}</div>
      </div>
    `;
    return el;
  }

  /**
   * Crea un elemento HTML para icono de usuario - ELIMINADO (solo marcador local)
   */

  ngAfterViewInit(): void {
    this.initMap();
    // Activar Wake Lock para evitar que la pantalla se apague
    this.activarWakeLock();
    // Validar GPS antes de inicializar geolocalización
    this.validarYActivarGPS().then(() => {
      if (this.gpsValidado) {
        this.initGeolocation();
      }
    }).catch(() => {
      // Si falla la validación, aún inicializar geolocalización para que funcione cuando se active
      this.initGeolocation();
    });
    this.initNotifications();
    // initUbicacionesTiempoReal() - ELIMINADO (solo marcador local)
    
    // Listener para abrir modal de imagen desde popups
    this.imagePopupListener = (event: any) => {
      if (event.detail) {
        this.openImageModal(event.detail);
      }
    };
    window.addEventListener('openImageFromPopup', this.imagePopupListener);
  }

  ngOnDestroy(): void {
    // Desactivar Wake Lock
    this.desactivarWakeLock();
    
    // Remover listener de eventos personalizados
    if (this.imagePopupListener) {
      window.removeEventListener('openImageFromPopup', this.imagePopupListener);
    }
    
    // Detener geolocalización
    this.geoService.stopTracking();
    if (this.geoSubscription) {
      this.geoSubscription.unsubscribe();
    }

    // Cancelar animación si está activa
    if (this.smoothMoveAnimation) {
      cancelAnimationFrame(this.smoothMoveAnimation);
    }

    // Limpiar marcadores de usuarios - ELIMINADO (solo marcador local)

    // Limpiar marcadores guardados
    this.savedMarkers.forEach(marker => {
      marker.remove();
    });
    this.savedMarkers = [];

    // Limpiar mapa
    if (this.map) {
      this.map.remove();
    }

    // Limpiar suscripciones de socket
    this.socketSubscriptions.forEach(sub => sub.unsubscribe());
    this.socketSubscriptions = [];

    // Limpiar listeners de notificaciones de conductores
    const socket = this.socketService.getSocket();
    if (socket) {
      if ((this as any).notificacionConductorHandler) {
        socket.off('notificacion-conductor', (this as any).notificacionConductorHandler);
      }
      if ((this as any).notificacionUsuarioLogueadoHandler) {
        socket.off('notificacion-usuario-logueado', (this as any).notificacionUsuarioLogueadoHandler);
      }
    }
  }

  private initMap(): void {
    // Coordenadas por defecto (se actualizarán con la ubicación real)
    const defaultCenter: [number, number] = [-74.8060, 11.0049]; // [lng, lat] para MapLibre

    // Crear mapa MapLibre con rotación multitouch y tilt
    this.map = new MapLibreMap({
      container: 'map',
      style: {
        version: 8,
        sources: {
          'raster-tiles': {
            type: 'raster',
            tiles: [this.getTileUrl(this.currentBaseKey)],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap contributors',
            // Configuración para evitar problemas de CORS
            scheme: 'xyz'
          }
        },
        layers: [
          {
            id: 'simple-tiles',
            type: 'raster',
            source: 'raster-tiles',
            minzoom: 0,
            maxzoom: 22
          }
        ]
      },
      center: defaultCenter,
      zoom: 13,
      pitch: 0,
      bearing: 0,
      dragRotate: true, // Rotación multitouch con dos dedos
      touchPitch: true, // Tilt con gestos
      touchZoomRotate: true
    });

    // Agregar controles de navegación
    this.map.addControl(new NavigationControl(), 'top-right');

    // Crear botón para resetear rotación
    this.createResetRotationButton();

    // Inicializar fuente y capa para rutas
    this.map.on('load', () => {
      if (this.map) {
        this.setupRouteLayer();
      }
    });
  }

  /**
   * Obtiene la URL de tiles según la capa seleccionada
   * MapLibre requiere URLs sin {s} para subdominios, usamos 'a', 'b', 'c' como alternativas
   * Todas las URLs usan servidores que soportan CORS para evitar errores de política de origen cruzado
   * 
   * Nota: Si aún tienes problemas de CORS, puedes usar un proxy CORS como:
   * 'https://cors-anywhere.herokuapp.com/https://tile.openstreetmap.org/{z}/{x}/{y}.png'
   * O configurar tu propio proxy CORS en el servidor
   */
  private getTileUrl(layerKey: string): string {
    const urls: Record<string, string> = {
      // CartoDB Voyager (estilo similar a OSM) - soporta CORS
      osmStandard: 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      osmHot: 'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      // Reemplazado OpenTopoMap (no soporta CORS, error 404) con CartoDB Voyager sin etiquetas
      // Esta capa ofrece un estilo más limpio sin etiquetas de calles, similar a un mapa topográfico
      // Alternativa: puedes usar 'https://tile.stamen.com/terrain/{z}/{x}/{y}.png' si configuras proxy CORS
      osmTopo: 'https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
      cartoPositron: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      cartoDark: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    };
    return urls[layerKey] || urls['osmStandard'];
  }

  /**
   * Crea botón para resetear rotación del mapa
   */
  private createResetRotationButton(): void {
    this.resetRotationButton = document.createElement('button');
    this.resetRotationButton.className = 'maplibregl-ctrl-icon maplibregl-ctrl-reset-rotation';
    this.resetRotationButton.type = 'button';
    this.resetRotationButton.innerHTML = '↻';
    this.resetRotationButton.title = 'Resetear rotación';
    this.resetRotationButton.style.cssText = `
      width: 30px;
      height: 30px;
      background-color: white;
      border: 1px solid rgba(0,0,0,0.2);
      border-radius: 4px;
      cursor: pointer;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 0 2px rgba(0,0,0,0.1);
    `;
    this.resetRotationButton.addEventListener('click', () => {
      if (this.map) {
        this.map.easeTo({
          bearing: 0,
          pitch: 0,
          duration: 600
        });
      }
    });

    // Agregar al mapa después de que se cargue
    if (this.map) {
      this.map.on('load', () => {
        const controls = document.querySelector('.maplibregl-ctrl-top-right');
        if (controls && this.resetRotationButton) {
          controls.appendChild(this.resetRotationButton);
        }
      });
    }
  }


  /**
   * Configura la capa para rutas (GeoJSON)
   */
  private setupRouteLayer(): void {
    if (!this.map) return;

    // Agregar fuente GeoJSON para rutas
    this.map.addSource(this.routeSourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: []
      }
    });

    // Agregar capa de línea para rutas
    this.map.addLayer({
      id: this.routeLayerId,
      type: 'line',
      source: this.routeSourceId,
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': '#3b82f6',
        'line-width': 4,
        'line-opacity': 0.7
      }
    });
  }

  cambiarCapa(baseKey: string): void {
    if (!this.map || !this.baseLayers[baseKey]) return;
    
    // Actualizar fuente de tiles
    const source = this.map.getSource('raster-tiles') as maplibregl.RasterTileSource;
    if (source) {
      source.setTiles([this.getTileUrl(baseKey)]);
    }
    
    this.currentBaseKey = baseKey;
  }

  /**
   * Métodos obligatorios requeridos por la especificación
   */

  /**
   * Crea el mapa (alias para initMap)
   */
  crearMapa(): void {
    this.initMap();
  }

  /**
   * Agrega marcador GPS del usuario (alias para updateUserLocation)
   */
  agregarMarcadorGPS(): void {
    // Este método se llama automáticamente desde initGeolocation
    // Se mantiene por compatibilidad
  }

  /**
   * Actualiza el marcador GPS con nuevos datos
   */
  actualizarMarcadorGPS(data: GeoPosition): void {
    this.updateUserLocation(data);
  }

  /**
   * Centra el mapa en el marcador draggable
   */
  centerOnDraggableMarker(): void {
    if (!this.map || !this.searchMarker) return;
    
    const lngLat = this.searchMarker.getLngLat();
    this.map.easeTo({
      center: [lngLat.lng, lngLat.lat],
      duration: 600
    });
  }

  /**
   * Configura el marcador draggable (alias para setupSearchMarker)
   */
  setupDraggableMarker(coords: [number, number]): void {
    this.setupSearchMarker(coords);
  }

  /**
   * Agrega un marcador guardado al mapa (alias para agregarMarcadorAlMapa)
   */
  agregarMarcadorGuardado(marcador: Marcador): void {
    this.agregarMarcadorAlMapa(marcador);
  }

  /**
   * Pinta una ruta en el mapa usando GeoJSON
   */
  pintarRuta(rutaCoords: Array<[number, number]>): void {
    if (!this.map) return;

    // Convertir coordenadas a formato GeoJSON LineString
    const coordinates = rutaCoords.map(coord => [coord[0], coord[1]]); // [lng, lat]

    const source = this.map.getSource(this.routeSourceId) as maplibregl.GeoJSONSource;
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: coordinates
            },
            properties: {}
          }
        ]
      });
    }
  }

  /**
   * Actualiza la ruta existente con nuevas coordenadas
   */
  actualizarRuta(rutaCoords: Array<[number, number]>): void {
    this.pintarRuta(rutaCoords);
  }

  /**
   * Cambia el estilo del mapa (alias para cambiarCapa)
   */
  cambiarEstiloMapa(styleUrl: string): void {
    // Buscar la clave de capa que corresponde al styleUrl
    const baseKey = Object.keys(this.baseLayers).find(key => 
      this.getTileUrl(key).includes(styleUrl) || styleUrl.includes(key)
    );
    
    if (baseKey) {
      this.cambiarCapa(baseKey);
    } else {
      // Si no se encuentra, intentar usar directamente
      const source = this.map?.getSource('raster-tiles') as maplibregl.RasterTileSource;
      if (source && this.map) {
        source.setTiles([styleUrl]);
      }
    }
  }

  async buscarDireccion(): Promise<void> {
    if (!this.map || !this.searchQuery.trim()) {
      return;
    }
    this.searchInProgress = true;
    this.searchError = null;
    this.searchResultValid = null;
    this.searchResults = [];

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        this.searchQuery.trim()
      )}&limit=5`;

      const res = await fetch(url, {
        headers: {
          'Accept-Language': 'es',
        },
      });

      const data = await res.json();

      if (!Array.isArray(data) || data.length === 0) {
        this.searchResultValid = false;
        this.searchError = 'No se encontraron resultados para esa dirección.';
        return;
      }

      this.searchResults = data.map((item: any) => ({
        displayName: item.display_name,
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon),
      }));

      // Marcar como "hay resultados" pero esperar a que el usuario seleccione uno
      this.searchResultValid = null;
    } catch (error) {
      console.error('Error al buscar dirección:', error);
      this.searchResultValid = false;
      this.searchError = 'Ocurrió un error al buscar la dirección.';
    } finally {
      this.searchInProgress = false;
    }
  }

  seleccionarResultado(result: { displayName: string; lat: number; lon: number }): void {
    if (!this.map) return;
    const coords: [number, number] = [result.lon, result.lat]; // [lng, lat] para MapLibre
    
    // Mover cámara suavemente
    this.map.easeTo({
      center: coords,
      zoom: 16,
      duration: 600
    });

    this.setupSearchMarker(coords);

    this.searchQuery = result.displayName;
    this.searchResults = [];
    this.searchResultValid = true;
    this.searchError = null;
  }

  onSearchChange(query: string): void {
    this.searchQuery = query;
    // Cancelar búsqueda anterior programada
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }

    // Si el usuario borró el texto, limpiamos estado y no buscamos
    if (!this.searchQuery.trim()) {
      this.searchResults = [];
      this.searchError = null;
      this.searchResultValid = null;
      return;
    }

    // Debounce de 1 segundo antes de lanzar la búsqueda
    this.searchTimeout = setTimeout(() => {
      this.buscarDireccion();
    }, 1000);
  }

  limpiarBusqueda(): void {
    // Cancelar búsqueda programada si existe
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = null;
    }

    // Limpiar todos los estados de búsqueda
    this.searchQuery = '';
    this.searchResults = [];
    this.searchError = null;
    this.searchResultValid = null;
    this.searchInProgress = false;

    // NO remover el marcador para que el usuario pueda seguir arrastrándolo
  }

  /**
   * Muestra u oculta la barra de búsqueda
   */
  toggleSearchBar(): void {
    this.searchBarVisible = !this.searchBarVisible;
    // Si se oculta, limpiar la búsqueda
    if (!this.searchBarVisible) {
      this.limpiarBusqueda();
    }
  }

  private setupSearchMarker(coords: [number, number]): void {
    if (!this.map) return;

    if (!this.searchMarker) {
      // Crear elemento HTML para el marcador de búsqueda (rojo)
      const el = document.createElement('div');
      el.className = 'search-marker';
      el.style.width = '25px';
      el.style.height = '41px';
      el.style.backgroundImage = 'url(https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png)';
      el.style.backgroundSize = 'contain';
      el.style.backgroundRepeat = 'no-repeat';
      el.style.cursor = 'grab';
      el.style.filter = 'hue-rotate(0deg) saturate(2)'; // Hacer rojo

      this.searchMarker = new Marker({
        element: el,
        draggable: true
      })
        .setLngLat(coords)
        .addTo(this.map);

      this.searchMarker.on('dragend', () => this.onMarkerDragEnd());
    } else {
      this.searchMarker.setLngLat(coords);
    }
  }

  private async onMarkerDragEnd(): Promise<void> {
    if (!this.map || !this.searchMarker) return;
    const lngLat = this.searchMarker.getLngLat();
    const lat = lngLat.lat;
    const lng = lngLat.lng;

    this.searchInProgress = true;
    this.searchError = null;

    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
      const res = await fetch(url, {
        headers: {
          'Accept-Language': 'es',
        },
      });
      const data = await res.json();

      if (!data) {
        // Si no hay datos, mostrar coordenadas
        this.searchQuery = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        this.searchResultValid = true;
        this.searchResults = [];
        return;
      }

      this.searchQuery = this.formatReverseAddress(data, lat, lng);
      this.searchResults = [];
      this.searchResultValid = true;
    } catch (error) {
      console.error('Error en reverse geocoding:', error);
      // En caso de error, mostrar coordenadas
      const lngLat = this.searchMarker!.getLngLat();
      this.searchQuery = `${lngLat.lat.toFixed(6)}, ${lngLat.lng.toFixed(6)}`;
      this.searchResultValid = true;
      this.searchError = null;
    } finally {
      this.searchInProgress = false;
    }
  }

  private formatReverseAddress(data: any, lat: number, lng: number): string {
    if (!data) {
      return `Coordenadas: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }
    
    const addr = data.address || {};
    const parts: string[] = [];

    // Número de casa/edificio
    if (addr.house_number) {
      parts.push(`#${addr.house_number}`);
    }

    // Calle/Vía principal
    if (addr.road) {
      parts.push(addr.road);
    } else if (addr.pedestrian) {
      parts.push(addr.pedestrian);
    } else if (addr.footway) {
      parts.push(addr.footway);
    } else if (addr.street) {
      parts.push(addr.street);
    } else if (addr.path) {
      parts.push(addr.path);
    }

    // Barrio/Localidad
    if (addr.neighbourhood) {
      parts.push(addr.neighbourhood);
    } else if (addr.suburb) {
      parts.push(addr.suburb);
    } else if (addr.quarter) {
      parts.push(addr.quarter);
    }

    // Municipio/Distrito
    if (addr.municipality) {
      parts.push(addr.municipality);
    } else if (addr.county) {
      parts.push(addr.county);
    } else if (addr.district) {
      parts.push(addr.district);
    }

    // Ciudad
    if (addr.city) {
      parts.push(addr.city);
    } else if (addr.town) {
      parts.push(addr.town);
    } else if (addr.village) {
      parts.push(addr.village);
    } else if (addr.hamlet) {
      parts.push(addr.hamlet);
    }

    // Estado/Provincia/Región
    if (addr.state) {
      parts.push(addr.state);
    } else if (addr.region) {
      parts.push(addr.region);
    } else if (addr.province) {
      parts.push(addr.province);
    }

    // Código postal
    if (addr.postcode) {
      parts.push(`C.P. ${addr.postcode}`);
    }

    // País
    if (addr.country) {
      parts.push(addr.country);
    }

    // Construir dirección completa
    let direccionCompleta = '';
    if (parts.length > 0) {
      direccionCompleta = parts.join(', ');
    } else if (data.display_name) {
      // Si no hay estructura pero hay display_name, usarlo
      direccionCompleta = data.display_name;
    }

    // Siempre agregar coordenadas al final
    const coordenadas = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    
    if (direccionCompleta) {
      return `${direccionCompleta} | Coordenadas: ${coordenadas}`;
    } else {
      return `Coordenadas: ${coordenadas}`;
    }
  }

  /**
   * Inicializa el seguimiento de geolocalización (híbrido: Capacitor primero, luego fallback)
   * El marcador de geolocalización es INDEPENDIENTE del marcador de búsqueda
   */
  private initGeolocation(): void {
    // Suscribirse a cambios de ubicación
    this.geoSubscription = this.geoService.currentPosition$.subscribe(
      (position: GeoPosition | null) => {
        if (position && this.map) {
          // Actualizar accuracy para mostrar en UI
          this.currentAccuracy = position.accuracy;
          
          // Solo actualizar el marcador GPS, NO centrar el mapa ni actualizar la barra de búsqueda
          this.updateUserLocation(position);
        }
      }
    );

    // Intentar obtener ubicación actual primero (híbrido: Capacitor primero, luego fallback)
    this.geoService.getCurrentPosition()
      .then((position: GeoPosition) => {
        if (this.map) {
          // Actualizar accuracy para mostrar en UI
          this.currentAccuracy = position.accuracy;
          
          // Centrar el mapa solo UNA VEZ al inicio en la ubicación real
          if (!this.mapCenteredOnce) {
            const initialCoords: [number, number] = [position.lng, position.lat]; // [lng, lat]
            this.map.easeTo({
              center: initialCoords,
              zoom: 13,
              duration: 600
            });
            this.mapCenteredOnce = true;
          }
          // Inicializar marcadores
          this.updateUserLocation(position);
        }
        // Iniciar seguimiento continuo (híbrido: Capacitor primero, luego fallback)
        this.geoService.iniciarGPS((coords) => {
          this.procesarNuevaCoordenada(coords);
        });
      })
      .catch((error) => {
        console.warn('No se pudo obtener la ubicación inicial:', error);
        // Iniciar seguimiento de todas formas (puede que el usuario permita después)
        this.geoService.iniciarGPS((coords) => {
          this.procesarNuevaCoordenada(coords);
        });
      });
  }

  /**
   * Procesa una nueva coordenada GPS
   * Mantiene toda la lógica existente de sockets y movimiento premium
   */
  private procesarNuevaCoordenada(position: GeoPosition): void {
    if (!this.map) return;

    // Actualizar accuracy para mostrar en UI
    this.currentAccuracy = position.accuracy;

    // Actualizar marcador GPS
    this.updateUserLocation(position);

    // Envío de ubicación vía socket - ELIMINADO (solo marcador local)
  }

  /**
   * Actualiza la posición del marcador de ubicación del usuario
   * Solo inicializa el marcador draggable UNA VEZ con la primera ubicación
   * Después solo actualiza el marcador real sin mover el mapa
   * Usa coordenadas exactas sin filtros, con validación estricta
   */
  private updateUserLocation(position: GeoPosition): void {
    if (!this.map) return;

    // Validar coordenadas estrictamente antes de procesar
    const sanitized = this.sanitizeLocation({ 
      lat: position.lat, 
      lng: position.lng, 
      accuracy: position.accuracy 
    });
    
    if (!sanitized) {
      // Coordenada inválida: no actualizar marcador, mantener última posición válida
      console.warn('⚠️ Coordenada GPS inválida descartada para marcador del usuario, manteniendo última posición válida');
      return;
    }

    // Usar coordenadas sanitizadas y validadas
    const newLngLat: [number, number] = [sanitized.lng, sanitized.lat];

    if (!this.userLocationMarker) {
      // Crear marcador GPS si no existe
      console.log('Creando marcador de ubicación GPS en:', newLngLat);
      
      // Crear elemento HTML para marcador GPS premium
      const el = document.createElement('div');
      el.className = 'user-location-marker';
      el.innerHTML = '<div class="user-location"></div>';
      
      this.userLocationMarker = new Marker({
        element: el
      })
        .setLngLat(newLngLat)
        .addTo(this.map);

      console.log('Marcador GPS creado:', this.userLocationMarker);

      // Inicializar el marcador draggable SOLO UNA VEZ con la posición inicial
      // IMPORTANTE: Solo inicializar si NO existe y NO se ha inicializado antes
      if (!this.hasInitializedDraggable && !this.searchMarker) {
        this.setupSearchMarker(newLngLat);
        // Actualizar la barra de búsqueda con la dirección de la ubicación GPS
        this.updateSearchQueryFromPosition(position);
        this.hasInitializedDraggable = true;
        console.log('Marcador draggable inicializado UNA VEZ en:', newLngLat);
      } else if (this.hasInitializedDraggable) {
        // Si ya se inicializó, NO hacer nada con el marcador draggable
        // NO moverlo, NO actualizarlo, NO cambiar sus coordenadas
      }
    } else {
      // Actualizar la posición del marcador directamente con coordenadas exactas
      this.userLocationMarker.setLngLat(newLngLat);
      
      // NO mostrar notificación de ubicación propia
      // Solo otros usuarios recibirán notificación cuando este usuario actualice su ubicación
      
      // GARANTIZAR que NO se actualice el marcador draggable
      // GARANTIZAR que NO se mueva la vista del mapa
      // GARANTIZAR que NO se aplique easeTo, flyTo, ni centrar automáticamente
      
      // Asegurar que hasInitializedDraggable esté en true para prevenir reinicialización
      if (!this.hasInitializedDraggable && this.searchMarker) {
        this.hasInitializedDraggable = true;
      }
    }
  }


  /**
   * Actualiza la barra de búsqueda con la dirección de la posición actual
   */
  private async updateSearchQueryFromPosition(position: GeoPosition): Promise<void> {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${position.lat}&lon=${position.lng}&zoom=18&addressdetails=1`;
      const res = await fetch(url, {
        headers: {
          'Accept-Language': 'es',
        },
      });
      const data = await res.json();

      if (data) {
        setTimeout(() => {
          this.searchQuery = this.formatReverseAddress(data, position.lat, position.lng);
          this.searchResultValid = true;
        }, 0);
      }
    } catch (error) {
      console.error('Error al obtener dirección de la ubicación:', error);
    }
  }

  /**
   * Abre el modal para agregar un marcador
   */
  abrirModalMarcador(): void {
    // Obtener coordenadas del marcador de búsqueda actual
    if (this.searchMarker) {
      const lngLat = this.searchMarker.getLngLat();
      this.coordenadasMarcador = {
        lat: lngLat.lat,
        lng: lngLat.lng
      };
    } else {
      // Si no hay marcador de búsqueda, usar coordenadas por defecto
      this.coordenadasMarcador = {
        lat: 11.0049,
        lng: -74.8060
      };
    }

    // Resetear formulario
    this.selectedCategory = 'alerta';
    this.descripcionMarcador = '';
    this.archivoSeleccionado = undefined;

    // Abrir modal
    this.modalMarcadorAbierto = true;
  }

  /**
   * Centra el mapa en el marcador GPS real del usuario
   * Útil para recuperar la posición cuando se pierde de vista
   */
  centrarMapa(): void {
    if (!this.map) {
      console.warn('⚠️ No se puede centrar el mapa: el mapa no está inicializado');
      return;
    }

    // Verificar si existe el marcador GPS del usuario
    if (!this.userLocationMarker) {
      console.warn('⚠️ No se puede centrar el mapa: el marcador GPS del usuario no existe');
      // Intentar obtener la ubicación actual si no existe el marcador
      this.geoService.getCurrentPosition()
        .then((position: GeoPosition) => {
          if (this.map) {
            const coords: [number, number] = [position.lng, position.lat];
            this.map.easeTo({
              center: coords,
              zoom: 15,
              duration: 800
            });
            console.log('📍 Mapa centrado en ubicación GPS actual');
          }
        })
        .catch((error) => {
          console.warn('⚠️ No se pudo obtener la ubicación GPS:', error);
        });
      return;
    }

    // Obtener la posición del marcador GPS
    const userLocation = this.userLocationMarker.getLngLat();
    if (userLocation) {
      const coords: [number, number] = [userLocation.lng, userLocation.lat];
      this.map.easeTo({
        center: coords,
        zoom: 15,
        duration: 800
      });
      console.log('📍 Mapa centrado en marcador GPS del usuario:', coords);
    } else {
      console.warn('⚠️ No se pudo obtener la posición del marcador GPS');
    }
  }

  /**
   * Mueve el marcador draggable al centro actual del mapa sin mover el mapa
   * 
   * Este método se ejecuta cuando el usuario hace clic en el botón "Mi ubicación"
   * en el speed-dial. Obtiene el centro actual del mapa y mueve el marcador
   * draggable a esa posición, manteniendo la capacidad de arrastre del marcador.
   */
  moverMarcadorAlCentro(): void {
    // Verificar que el mapa esté inicializado
    if (!this.map) {
      console.warn('⚠️ No se puede mover el marcador: el mapa no está inicializado');
      return;
    }

    // Obtener el centro actual del mapa
    const center = this.map.getCenter();
    
    // Verificar que el centro sea válido
    if (!center || !center.lat || !center.lng) {
      console.warn('⚠️ No se puede mover el marcador: centro del mapa inválido');
      return;
    }

    // Convertir a [lng, lat] para MapLibre
    const centerLngLat: [number, number] = [center.lng, center.lat];

    // Si el marcador draggable no existe, crearlo en el centro del mapa
    if (!this.searchMarker) {
      this.setupSearchMarker(centerLngLat);
      console.log(`📍 Marcador draggable creado en el centro del mapa: [${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}]`);
    } else {
      // Mover el marcador existente al centro del mapa
      this.searchMarker.setLngLat(centerLngLat);
      console.log(`📍 Marcador draggable movido al centro del mapa: [${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}]`);
    }

    // Actualizar la barra de búsqueda con la nueva ubicación mediante geocodificación inversa
    // Esto proporciona feedback visual al usuario sobre la nueva posición
    this.actualizarBarraBusquedaDesdeCoordenadas(center.lat, center.lng);
  }

  /**
   * Actualiza la barra de búsqueda con la dirección correspondiente a las coordenadas dadas
   * @param lat - Latitud
   * @param lng - Longitud
   */
  private async actualizarBarraBusquedaDesdeCoordenadas(lat: number, lng: number): Promise<void> {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
      const res = await fetch(url, {
        headers: {
          'Accept-Language': 'es',
        },
      });
      const data = await res.json();

      if (data) {
        this.searchQuery = this.formatReverseAddress(data, lat, lng);
        this.searchResultValid = true;
        this.searchError = null;
      }
    } catch (error) {
      console.warn('⚠️ No se pudo obtener la dirección del centro del mapa:', error);
      // En caso de error, mostrar las coordenadas
      this.searchQuery = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      this.searchResultValid = true;
    }
  }

  /**
   * Cierra el modal de marcador
   */
  cerrarModalMarcador(): void {
    this.modalMarcadorAbierto = false;
    // Limpiar formulario
    this.selectedCategory = 'alerta';
    this.descripcionMarcador = '';
    this.archivoSeleccionado = undefined;
    // NO limpiar coordenadasMarcador para evitar que afecte el marcador draggable
    // NO mover el mapa
    // NO cambiar la posición del marcador draggable
  }

  /**
   * Obtiene el nombre de la categoría
   */
  getCategoryName(category: string): string {
    const names: Record<string, string> = {
      'alerta': 'Alerta',
      'peligro': 'Peligro',
      'informacion': 'Información'
    };
    return names[category] || category;
  }

  /**
   * Muestra una alerta usando DaisyUI
   */
  mostrarAlerta(mensaje: string, tipo: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
    this.alertaMensaje = mensaje;
    this.alertaTipo = tipo;
    this.alertaVisible = true;
    
    // Auto-ocultar después de 5 segundos
    setTimeout(() => {
      this.alertaVisible = false;
    }, 5000);
  }

  /**
   * Cierra la alerta manualmente
   */
  cerrarAlerta(): void {
    this.alertaVisible = false;
  }

  /**
   * Obtiene la URL completa del archivo
   */
  getFileUrl(archivo: string | null | undefined): string | null {
    if (!archivo) return null;
    // Si es una URL relativa del servidor, construir la URL completa
    if (archivo.startsWith('/api/files/')) {
      // Extraer el dominio base del socketUrl (sin /api)
      const baseUrl = environment.socketUrl;
      return `${baseUrl}${archivo}`;
    }
    // Si es Base64 (legacy), devolverlo tal cual
    if (archivo.startsWith('data:')) {
      return archivo;
    }
    return archivo;
  }

  /**
   * Verifica si el archivo es una imagen
   */
  isImage(archivo: string | null | undefined): boolean {
    if (!archivo) return false;
    return archivo.includes('/imagenes/') || archivo.startsWith('data:image/');
  }

  /**
   * Verifica si el archivo es un video
   */
  isVideo(archivo: string | null | undefined): boolean {
    if (!archivo) return false;
    // Verificar por ruta de videos en el servidor
    const esRutaVideo = archivo.includes('/videos/') || archivo.includes('/api/files/videos/');
    // Verificar por extensión de archivo (común en nombres de archivo)
    const extensionesVideo = /\.(mp4|webm|ogg|ogv|mov|avi|wmv|flv|mkv|3gp|m4v|mpg|mpeg)(\?|$)/i;
    const esExtensionVideo = extensionesVideo.test(archivo);
    // Verificar por tipo MIME (Base64 o data URLs)
    const esMimeVideo = archivo.startsWith('data:video/');
    return esRutaVideo || esExtensionVideo || esMimeVideo;
  }

  /**
   * Maneja la selección de archivo
   */
  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.archivoSeleccionado = input.files[0];
      // El archivo se enviará directamente como File, no se convierte a Base64
    }
  }


  /**
   * Guarda el marcador en el servidor
   */
  guardarMarcador(): void {
    if (!this.coordenadasMarcador || !this.selectedCategory || !this.descripcionMarcador.trim() || this.descripcionMarcador.trim().length < 10) {
      return;
    }

    const marcadorData = {
      lat: this.coordenadasMarcador.lat,
      lng: this.coordenadasMarcador.lng,
      categoria: this.selectedCategory,
      descripcion: this.descripcionMarcador.trim()
    };

    // Activar loading
    this.loadingVisible = true;
    this.loadingMensaje = 'Guardando marcador...';

    // Guardar en el servidor (enviar archivo como File, no Base64)
    this.apiService.createMarcador(marcadorData, this.archivoSeleccionado || undefined).subscribe({
      next: (response) => {
        this.loadingVisible = false;
        if (response.success && response.data) {
          console.log('Marcador guardado en servidor:', response.data);
          
          // IMPORTANTE: Guardar la posición actual del mapa y del marcador draggable
          // antes de cualquier operación para evitar que se muevan después de guardar
          const currentMapCenter = this.map?.getCenter();
          const currentMapZoom = this.map?.getZoom();
          const currentSearchMarkerPos = this.searchMarker?.getLngLat();
          
          // Cerrar modal y limpiar formulario
          this.cerrarModalMarcador();
          
          // Si hay marcadores cargados en el mapa, agregar el nuevo marcador en tiempo real
          if (this.savedMarkers.length > 0 && response.data) {
            this.agregarMarcadorAlMapa(response.data);
            
            // RESTAURAR la posición del mapa después de agregar el marcador (usar setTimeout para asegurar que se ejecute después)
            setTimeout(() => {
              if (this.map && currentMapCenter && currentMapZoom !== undefined) {
                const newCenter = this.map.getCenter();
                // Calcular distancia aproximada
                const lat1 = currentMapCenter.lat;
                const lng1 = currentMapCenter.lng;
                const lat2 = newCenter.lat;
                const lng2 = newCenter.lng;
                const R = 6371000; // Radio de la Tierra en metros
                const dLat = (lat2 - lat1) * Math.PI / 180;
                const dLng = (lng2 - lng1) * Math.PI / 180;
                const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLng/2) * Math.sin(dLng/2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                const distance = R * c;
                // Si el mapa se movió más de 1 metro, restaurar la posición original
                if (distance > 1) {
                  this.map.easeTo({
                    center: [currentMapCenter.lng, currentMapCenter.lat],
                    zoom: currentMapZoom,
                    duration: 0
                  });
                  console.log('Mapa restaurado a posición original después de guardar marcador');
                }
              }
              
              // ASEGURAR que el marcador draggable no cambió de posición
              if (this.searchMarker && currentSearchMarkerPos) {
                const currentPos = this.searchMarker.getLngLat();
                // Calcular distancia aproximada
                const lat1 = currentSearchMarkerPos.lat;
                const lng1 = currentSearchMarkerPos.lng;
                const lat2 = currentPos.lat;
                const lng2 = currentPos.lng;
                const R = 6371000; // Radio de la Tierra en metros
                const dLat = (lat2 - lat1) * Math.PI / 180;
                const dLng = (lng2 - lng1) * Math.PI / 180;
                const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLng/2) * Math.sin(dLng/2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                const distance = R * c;
                // Si el marcador se movió más de 1 metro, restaurar la posición original
                if (distance > 1) {
                  this.searchMarker.setLngLat(currentSearchMarkerPos);
                  console.log('Marcador draggable restaurado a posición original después de guardar');
                }
              }
            }, 100); // Pequeño delay para asegurar que cualquier operación asíncrona termine
            
            this.mostrarAlerta('Marcador guardado y agregado al mapa en tiempo real', 'success');
          } else {
            // Si no hay marcadores cargados, solo mostrar mensaje
            this.mostrarAlerta('Marcador guardado exitosamente en el servidor', 'success');
          }
        } else {
          this.mostrarAlerta('Error al guardar: ' + (response.error || 'Error desconocido'), 'error');
        }
      },
      error: (error) => {
        this.loadingVisible = false;
        console.error('Error al guardar en servidor:', error);
        this.mostrarAlerta('Error al guardar el marcador. Verifica la conexión al servidor.', 'error');
      }
    });
  }


  /**
   * Carga y muestra todos los marcadores guardados desde la API
   */
  cargarMarcadoresGuardados(): void {
    this.cargandoMarcadores = true;
    this.loadingVisible = true;
    this.loadingMensaje = 'Cargando marcadores...';
    this.modalGestionMarcadoresAbierto = true;

    this.apiService.getMarcadores().subscribe({
      next: (response) => {
        this.cargandoMarcadores = false;
        this.loadingVisible = false;
        if (response.success && response.data) {
          this.marcadoresGuardados = response.data;
          if (this.marcadoresGuardados.length === 0) {
            this.mostrarAlerta('No hay marcadores guardados en el servidor', 'info');
          }
        } else {
          this.mostrarAlerta('Error al cargar marcadores: ' + (response.error || 'Error desconocido'), 'error');
        }
      },
      error: (error) => {
        this.cargandoMarcadores = false;
        this.loadingVisible = false;
        console.error('Error al cargar marcadores:', error);
        this.mostrarAlerta('Error al conectar con el servidor. Verifica que el servidor esté ejecutándose.', 'error');
      }
    });
  }

  /**
   * Cierra el modal de gestión de marcadores
   */
  cerrarModalGestionMarcadores(): void {
    this.modalGestionMarcadoresAbierto = false;
    this.marcadoresGuardados = [];
  }

  /**
   * Carga los marcadores en el mapa
   */
  cargarMarcadoresEnMapa(): void {
    if (!this.map) return;

    // Limpiar marcadores anteriores (sin mostrar mensaje)
    this.limpiarMarcadoresGuardadosInterno();

    let cantidad_marcadores = this.marcadoresGuardados.length;

    if (this.marcadoresGuardados.length === 0) {
      this.mostrarAlerta('No hay marcadores para cargar', 'warning');
      return;
    }

    // Activar loading
    this.loadingVisible = true;
    this.loadingMensaje = 'Cargando marcadores en el mapa...';

    // Crear y agregar marcadores al mapa
    console.log(this.marcadoresGuardados);
    const bounds: maplibregl.LngLatBounds = new maplibregl.LngLatBounds();
    
    this.marcadoresGuardados.forEach((marcadorData) => {
      const icono = this.categoryIcons[marcadorData.categoria];
      if (!icono) return;

      // Clonar el elemento para cada marcador
      const iconoClone = icono.cloneNode(true) as HTMLElement;
      
      const marker = new Marker({
        element: iconoClone
      })
        .setLngLat([marcadorData.lng, marcadorData.lat])
        .addTo(this.map!);

      // Crear contenido del popup
      const categoriaNombre = this.getCategoryName(marcadorData.categoria);
      const fecha = marcadorData.timestamp 
        ? new Date(marcadorData.timestamp).toLocaleString('es-ES')
        : 'Fecha no disponible';
      
      let popupContent = `
        <div class="popup-content" style="min-width: 200px;">
          <h3 style="margin: 0 0 8px 0; font-weight: bold; color: #1f2937;">
            ${categoriaNombre}
          </h3>
          <p style="margin: 0 0 8px 0; color: #4b5563;">${marcadorData.descripcion}</p>
          <div style="margin: 8px 0; padding: 8px; background: #f3f4f6; border-radius: 4px;">
            <p style="margin: 0; font-size: 11px; color: #6b7280;">
              <strong>Coordenadas:</strong><br>
              ${marcadorData.lat.toFixed(6)}, ${marcadorData.lng.toFixed(6)}
            </p>
            <p style="margin: 4px 0 0 0; font-size: 11px; color: #6b7280;">
              <strong>Fecha:</strong> ${fecha}
            </p>
          </div>
      `;

      // Si hay archivo adjunto y es una imagen, mostrarla directamente
      if (marcadorData.archivo && this.isImage(marcadorData.archivo)) {
        const archivoUrl = this.getFileUrl(marcadorData.archivo);
        if (archivoUrl) {
          // Escapar comillas simples en la URL para evitar problemas en el atributo onclick
          const escapedUrl = archivoUrl.replace(/'/g, "\\'");
          popupContent += `
            <div style="margin-top: 8px;">
              <img src="${archivoUrl}" 
                   alt="Imagen adjunta" 
                   class="w-20 h-20 object-cover rounded-md cursor-pointer"
                   onclick="window.dispatchEvent(new CustomEvent('openImageFromPopup', { detail: '${escapedUrl}' }))"
                   style="max-width: 200px; max-height: 150px; border-radius: 4px; object-fit: cover; display: block; cursor: pointer;">
            </div>
          `;
        }
      }

      popupContent += `</div>`;

      const popup = new Popup({ offset: 25 })
        .setHTML(popupContent);
      
      marker.setPopup(popup);
      
      // Guardar datos del marcador para referencia
      (marker as any).marcadorData = marcadorData;
      
      this.savedMarkers.push(marker);
      bounds.extend([marcadorData.lng, marcadorData.lat]);
    });

    // Ajustar vista del mapa para mostrar todos los marcadores
    if (this.savedMarkers.length > 0 && bounds.getNorth() !== bounds.getSouth()) {
      this.map!.fitBounds(bounds, {
        padding: 50,
        duration: 600
      });
    }

    // Desactivar loading
    this.loadingVisible = false;
    this.cerrarModalGestionMarcadores();
    this.mostrarAlerta(`Se cargaron ${cantidad_marcadores} marcador(es) en el mapa`, 'success');

    // Inicializar listeners de socket para tiempo real (solo si hay marcadores cargados)
    this.initSocketListeners();
  }

  /**
   * Agrega un marcador individual al mapa (helper para tiempo real)
   */
  private agregarMarcadorAlMapa(marcadorData: Marcador): void {
    if (!this.map || !marcadorData.id) return;

    // Verificar si el marcador ya existe en el mapa
    const existeMarcador = this.savedMarkers.some((marker: any) => {
      const markerData = marker.marcadorData;
      return markerData?.id === marcadorData.id;
    });

    if (existeMarcador) return;

    const icono = this.categoryIcons[marcadorData.categoria];
    if (!icono) return;

    // Clonar el elemento para cada marcador
    const iconoClone = icono.cloneNode(true) as HTMLElement;
    
    const marker = new Marker({
      element: iconoClone
    })
      .setLngLat([marcadorData.lng, marcadorData.lat]);

    // Crear contenido del popup
    const categoriaNombre = this.getCategoryName(marcadorData.categoria);
    const fecha = marcadorData.timestamp 
      ? new Date(marcadorData.timestamp).toLocaleString('es-ES')
      : marcadorData.created_at
      ? new Date(marcadorData.created_at).toLocaleString('es-ES')
      : 'Fecha no disponible';
    
    let popupContent = `
      <div class="popup-content" style="min-width: 200px;">
        <h3 style="margin: 0 0 8px 0; font-weight: bold; color: #1f2937;">
          ${categoriaNombre}
        </h3>
        <p style="margin: 0 0 8px 0; color: #4b5563;">${marcadorData.descripcion}</p>
        <div style="margin: 8px 0; padding: 8px; background: #f3f4f6; border-radius: 4px;">
          <p style="margin: 0; font-size: 11px; color: #6b7280;">
            <strong>Coordenadas:</strong><br>
            ${marcadorData.lat.toFixed(6)}, ${marcadorData.lng.toFixed(6)}
          </p>
          <p style="margin: 4px 0 0 0; font-size: 11px; color: #6b7280;">
            <strong>Fecha:</strong> ${fecha}
          </p>
        </div>
    `;

    // Si hay archivo adjunto y es una imagen, mostrarla directamente
    if (marcadorData.archivo && this.isImage(marcadorData.archivo)) {
      const archivoUrl = this.getFileUrl(marcadorData.archivo);
      if (archivoUrl) {
        // Escapar comillas simples en la URL para evitar problemas en el atributo onclick
        const escapedUrl = archivoUrl.replace(/'/g, "\\'");
        popupContent += `
          <div style="margin-top: 8px;">
            <img src="${archivoUrl}" 
                 alt="Imagen adjunta" 
                 class="w-20 h-20 object-cover rounded-md cursor-pointer"
                 onclick="window.dispatchEvent(new CustomEvent('openImageFromPopup', { detail: '${escapedUrl}' }))"
                 style="max-width: 200px; max-height: 150px; border-radius: 4px; object-fit: cover; display: block; cursor: pointer;">
          </div>
        `;
      }
    }

    // Si hay archivo adjunto y es un video, mostrar indicador
    if (marcadorData.archivo && this.isVideo(marcadorData.archivo)) {
      popupContent += `
        <div style="margin-top: 8px; padding: 6px; background: #eff6ff; border-radius: 4px; font-size: 11px; color: #1e40af;">
          🎥 Video adjunto
        </div>
      `;
    }

    popupContent += `</div>`;

    const popup = new Popup({ offset: 25 })
      .setHTML(popupContent);
    
    marker.setPopup(popup);
    
    // Guardar datos del marcador en el marker para referencia
    (marker as any).marcadorData = marcadorData;
    
    marker.addTo(this.map);
    this.savedMarkers.push(marker);

    // Actualizar lista de marcadores guardados si no existe
    const existeEnLista = this.marcadoresGuardados.some(m => m.id === marcadorData.id);
    if (!existeEnLista) {
      this.marcadoresGuardados.push(marcadorData);
    }
  }

  /**
   * Abre el modal para editar un marcador
   */
  abrirModalEditarMarcador(marcador: Marcador): void {
    this.marcadorEditando = { ...marcador };
    this.selectedCategory = marcador.categoria;
    this.descripcionMarcador = marcador.descripcion;
    this.coordenadasMarcador = { lat: marcador.lat, lng: marcador.lng };
    // El archivo existente se muestra desde la URL del servidor
    this.archivoSeleccionado = undefined;
    this.modalEditarMarcadorAbierto = true;
  }

  /**
   * Cierra el modal de edición
   */
  cerrarModalEditarMarcador(): void {
    this.modalEditarMarcadorAbierto = false;
    this.marcadorEditando = undefined;
    this.selectedCategory = 'alerta';
    this.descripcionMarcador = '';
    this.archivoSeleccionado = undefined;
  }

  /**
   * Guarda los cambios del marcador editado
   */
  guardarMarcadorEditado(): void {
    if (!this.marcadorEditando || !this.marcadorEditando.id) return;
    if (!this.descripcionMarcador.trim() || this.descripcionMarcador.trim().length < 10) {
      this.mostrarAlerta('La descripción debe tener al menos 10 caracteres', 'warning');
      return;
    }

    const marcadorActualizado = {
      lat: this.coordenadasMarcador?.lat || this.marcadorEditando.lat,
      lng: this.coordenadasMarcador?.lng || this.marcadorEditando.lng,
      categoria: this.selectedCategory,
      descripcion: this.descripcionMarcador.trim()
    };

    // Activar loading
    this.loadingVisible = true;
    this.loadingMensaje = 'Actualizando marcador...';

    // Enviar archivo como File si hay uno nuevo, no Base64
    this.apiService.updateMarcador(this.marcadorEditando.id, marcadorActualizado, this.archivoSeleccionado || undefined).subscribe({
      next: (response) => {
        this.loadingVisible = false;
        if (response.success && response.data) {
          // Actualizar en la lista local
          const index = this.marcadoresGuardados.findIndex(m => m.id === this.marcadorEditando?.id);
          if (index !== -1) {
            this.marcadoresGuardados[index] = response.data;
          }

          // Si hay marcadores cargados, actualizar el marcador en el mapa en tiempo real
          if (this.savedMarkers.length > 0 && response.data) {
            // Buscar y remover el marcador antiguo
            const markerIndex = this.savedMarkers.findIndex((marker: any) => {
              return marker.marcadorData?.id === response.data?.id;
            });

            if (markerIndex !== -1) {
              const oldMarker = this.savedMarkers[markerIndex];
              oldMarker.remove();
              this.savedMarkers.splice(markerIndex, 1);
            }

            // Agregar el marcador actualizado
            this.agregarMarcadorAlMapa(response.data);
          }

          this.cerrarModalEditarMarcador();
          this.mostrarAlerta('Marcador actualizado correctamente', 'success');
        } else {
          this.mostrarAlerta('Error al actualizar: ' + (response.error || 'Error desconocido'), 'error');
        }
      },
      error: (error) => {
        this.loadingVisible = false;
        console.error('Error al actualizar marcador:', error);
        this.mostrarAlerta('Error al actualizar el marcador', 'error');
      }
    });
  }

  /**
   * Elimina un marcador
   */
  eliminarMarcador(marcador: Marcador): void {
    if (!marcador.id) return;

    if (!confirm(`¿Estás seguro de eliminar el marcador "${marcador.descripcion.substring(0, 30)}..."?`)) {
      return;
    }

    // Activar loading
    this.loadingVisible = true;
    this.loadingMensaje = 'Eliminando marcador...';

    this.apiService.deleteMarcador(marcador.id).subscribe({
      next: (response) => {
        this.loadingVisible = false;
        if (response.success) {
          // Remover de la lista local
          this.marcadoresGuardados = this.marcadoresGuardados.filter(m => m.id !== marcador.id);
          this.mostrarAlerta('Marcador eliminado correctamente', 'success');
        } else {
          this.mostrarAlerta('Error al eliminar: ' + (response.error || 'Error desconocido'), 'error');
        }
      },
      error: (error) => {
        this.loadingVisible = false;
        console.error('Error al eliminar marcador:', error);
        this.mostrarAlerta('Error al eliminar el marcador', 'error');
      }
    });
  }

  /**
   * Limpia todos los marcadores guardados del mapa (versión privada sin feedback)
   */
  private limpiarMarcadoresGuardadosInterno(): void {
    this.savedMarkers.forEach(marker => {
      marker.remove();
    });
    this.savedMarkers = [];
  }

  /**
   * Limpia todos los marcadores guardados del mapa (versión pública con feedback)
   */
  limpiarMarcadoresGuardados(): void {
    // Verificar si hay marcadores para limpiar
    if (this.savedMarkers.length === 0) {
      this.mostrarAlerta('No hay marcadores en el mapa para limpiar', 'info');
      return;
    }

    const cantidadEliminados = this.savedMarkers.length;
    
    // Limpiar todos los marcadores del mapa
    this.limpiarMarcadoresGuardadosInterno();

    // Desactivar listeners de socket ya que no hay marcadores cargados
    this.desactivarSocketListeners();

    // Mostrar feedback al usuario
    this.mostrarAlerta(`${cantidadEliminados} marcador${cantidadEliminados > 1 ? 'es' : ''} eliminado${cantidadEliminados > 1 ? 's' : ''} del mapa`, 'success');
  }

  /**
   * Abre la modal de reproducción de video
   */
  abrirModalVideo(archivo: string | null | undefined): void {
    if (!archivo) return;
    const videoUrl = this.getFileUrl(archivo);
    if (!videoUrl) return;
    this.videoUrlActual = videoUrl;
    this.modalVideoAbierto = true;
  }

  /**
   * Cierra la modal de video
   */
  cerrarModalVideo(): void {
    this.modalVideoAbierto = false;
    this.videoUrlActual = null;
  }

  /**
   * Abre el modal para mostrar una imagen en pantalla grande
   * @param imageUrl - URL de la imagen a mostrar
   */
  openImageModal(imageUrl: string): void {
    this.selectedImage = imageUrl;
    this.showImageModal = true;
  }

  /**
   * Cierra el modal de imagen
   */
  closeImageModal(): void {
    this.showImageModal = false;
    this.selectedImage = null;
  }

  /**
   * Inicializa los listeners de socket para recibir marcadores en tiempo real
   * Solo para actualización del mapa (las notificaciones se manejan en initNotifications)
   * NOTA: Este método ahora solo maneja otros eventos de socket relacionados con marcadores,
   * las notificaciones de marcadores creados se manejan en initNotifications para estar siempre activas
   */
  private initSocketListeners(): void {
    // Solo inicializar si hay marcadores cargados y no se han inicializado ya
    if (this.savedMarkers.length === 0 || this.socketListenersInicializados) {
      return;
    }

    this.socketListenersInicializados = true;

    // NOTA: El listener de marcador:creado está en initNotifications() para estar siempre activo

    // Escuchar marcadores actualizados por otros usuarios
    const subActualizado = this.socketService.onMarcadorActualizado().subscribe((marcador: Marcador) => {
      // Solo actualizar si hay marcadores cargados
      if (this.savedMarkers.length > 0 && marcador.id) {
        console.log('📝 Marcador actualizado en tiempo real:', marcador);
        
        // Buscar y remover el marcador antiguo
        const markerIndex = this.savedMarkers.findIndex((marker: any) => {
          return marker.marcadorData?.id === marcador.id;
        });

        if (markerIndex !== -1) {
          const oldMarker = this.savedMarkers[markerIndex];
          oldMarker.remove();
          this.savedMarkers.splice(markerIndex, 1);
        }

        // Agregar el marcador actualizado
        this.agregarMarcadorAlMapa(marcador);
        
        // Actualizar en la lista también
        const listaIndex = this.marcadoresGuardados.findIndex(m => m.id === marcador.id);
        if (listaIndex !== -1) {
          this.marcadoresGuardados[listaIndex] = marcador;
        }
      }
    });
    this.socketSubscriptions.push(subActualizado);

    // Escuchar marcadores eliminados por otros usuarios
    const subEliminado = this.socketService.onMarcadorEliminado().subscribe((data: { id: string }) => {
      // Solo eliminar si hay marcadores cargados
      if (this.savedMarkers.length > 0) {
        console.log('🗑️ Marcador eliminado en tiempo real:', data.id);
        
        // Buscar y remover el marcador
        const markerIndex = this.savedMarkers.findIndex((marker: any) => {
          return marker.marcadorData?.id === data.id;
        });

        if (markerIndex !== -1) {
          const marker = this.savedMarkers[markerIndex];
          marker.remove();
          this.savedMarkers.splice(markerIndex, 1);
        }

        // Remover de la lista también
        this.marcadoresGuardados = this.marcadoresGuardados.filter(m => m.id !== data.id);
        this.mostrarAlerta('Marcador eliminado en tiempo real', 'info');
      }
    });
    this.socketSubscriptions.push(subEliminado);
  }

  /**
   * Desactiva los listeners de socket cuando se limpian los marcadores
   */
  private desactivarSocketListeners(): void {
    if (!this.socketListenersInicializados) return;

    // Limpiar suscripciones
    this.socketSubscriptions.forEach(sub => sub.unsubscribe());
    this.socketSubscriptions = [];
    this.socketListenersInicializados = false;
  }

  /**
   * Inicializa el sistema de notificaciones
   */
  private initNotifications(): void {
    // Usar setTimeout para inicializar después del ciclo de detección actual
    // Esto evita ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => {
      // Suscribirse a cambios en las notificaciones para actualizar el contador
      const subNotifications = this.notificationService.getNotifications().subscribe(
        notifications => {
          this.unreadNotificationsCount = notifications.filter(n => !n.read).length;
          this.cdr.markForCheck();
        }
      );
      this.socketSubscriptions.push(subNotifications);

      // Escuchar cuando un cliente se conecta (solo primera vez, no reconexiones)
      const subClienteConectado = this.socketService.onClienteConectado().subscribe((data: any) => {
        const myUserId = this.userService.getUserIdSync();
        const connectedUserId = data?.userId;
        
        // Solo mostrar notificación si NO es el usuario actual
        if (connectedUserId && connectedUserId !== myUserId) {
          const numUsuario = data?.numUsuario;
          const plataforma = data?.plataforma || 'web';
          const identificador = numUsuario ? `${numUsuario}-${plataforma}` : plataforma;
          this.notificationService.pushNotification(`Cliente conectado: ${identificador}`, 'info');
        }
      });
      this.socketSubscriptions.push(subClienteConectado);

      // Escuchar cuando un cliente se desconecta
      const subClienteDesconectado = this.socketService.onClienteDesconectado().subscribe((data: any) => {
        const myUserId = this.userService.getUserIdSync();
        const disconnectedUserId = data?.userId;
        
        // Solo mostrar notificación si NO es el usuario actual
        if (disconnectedUserId && disconnectedUserId !== myUserId) {
          const numUsuario = data?.numUsuario;
          const plataforma = data?.plataforma || 'web';
          const identificador = numUsuario ? `${numUsuario}-${plataforma}` : plataforma;
          this.notificationService.pushNotification(`Cliente desconectado: ${identificador}`, 'warning');
        }
      });
      this.socketSubscriptions.push(subClienteDesconectado);

      // Escuchar nuevos marcadores creados por otros usuarios
      // IMPORTANTE: Este listener SIEMPRE funciona para notificaciones
      const subMarcadorCreado = this.socketService.onMarcadorCreado().subscribe((marcador: Marcador) => {
        console.log('🔔 Evento marcador:creado recibido:', marcador);
        
        const myUserId = this.userService.getUserIdSync();
        const marcadorUserId = (marcador as any).user_id;
        
        console.log(`🔍 Verificando marcador - Mi userId: ${myUserId}, Marcador userId: ${marcadorUserId}`);
        
        // VERIFICACIÓN CRÍTICA: Si el marcador es del usuario actual, NO procesarlo
        if (marcadorUserId && marcadorUserId === myUserId) {
          console.log(`📝 Marcador creado por mí (${myUserId}), ignorando evento de socket para evitar notificación propia`);
          return; // Salir temprano - no procesar ni notificar
        }
        
        // El marcador es de otro usuario, procesarlo
        console.log('📥 Marcador nuevo recibido en tiempo real (de otro usuario):', marcador);
        
        // Solo agregar al mapa si hay marcadores cargados
        if (this.savedMarkers.length > 0) {
          this.agregarMarcadorAlMapa(marcador);
          this.mostrarAlerta('Nuevo marcador agregado en tiempo real', 'info');
        }
        
        // SIEMPRE mostrar notificación si es de otro usuario (independientemente de si hay marcadores cargados)
        if (marcadorUserId && marcadorUserId !== myUserId) {
          const numUsuario = (marcador as any).usuario_num;
          const plataforma = marcador.usuario_plataforma || 'web';
          const identificador = numUsuario ? `${numUsuario}-${plataforma}` : plataforma;
          console.log(`✅ Mostrando notificación para marcador de usuario: ${identificador}`);
          this.notificationService.pushNotification(`Nuevo marcador guardado por cliente: ${identificador}`, 'success');
        } else {
          console.log('⚠️  No se muestra notificación - marcador sin user_id o del mismo usuario');
        }
      });
      this.socketSubscriptions.push(subMarcadorCreado);

      // Escuchar notificaciones de conductores (activo/inactivo)
      const socket = this.socketService.getSocket();
      
      const notificacionConductorHandler = (data: { tipo: string; usuario: string; mensaje: string }) => {
        if (data.tipo === 'activo') {
          this.notificationService.pushNotification(data.mensaje, 'success');
          this.mostrarAlerta(data.mensaje, 'success');
        } else if (data.tipo === 'inactivo') {
          this.notificationService.pushNotification(data.mensaje, 'warning');
          this.mostrarAlerta(data.mensaje, 'warning');
        }
      };
      
      const notificacionUsuarioLogueadoHandler = (data: { usuario: string; rol: string; mensaje: string }) => {
        // Solo mostrar si el usuario actual es conductor
        if (this.usuarioLogueado && this.usuarioLogueado.rol === 'conductor') {
          this.notificationService.pushNotification(data.mensaje, 'info');
          this.mostrarAlerta(data.mensaje, 'info');
        }
      };

      socket.on('notificacion-conductor', notificacionConductorHandler);
      socket.on('notificacion-usuario-logueado', notificacionUsuarioLogueadoHandler);

      // Guardar referencias para limpiar en ngOnDestroy
      (this as any).notificacionConductorHandler = notificacionConductorHandler;
      (this as any).notificacionUsuarioLogueadoHandler = notificacionUsuarioLogueadoHandler;
    }, 0);

    // La notificación de marcador guardado se maneja en initSocketListeners
    // para evitar duplicados y solo mostrar cuando es de otro cliente
  }

  /**
   * Muestra u oculta el panel de notificaciones
   */
  toggleNotifications(): void {
    this.notificationsPanelVisible = !this.notificationsPanelVisible;
  }

  /**
   * Inicializa el sistema de ubicaciones en tiempo real - ELIMINADO
   * Solo se mantiene el marcador local y draggable
   */

  /**
   * Sanitiza y valida coordenadas GPS estrictamente
   * Retorna coordenada válida o null si debe descartarse
   */
  private sanitizeLocation(data: { lat: number; lng: number; accuracy?: number | null }): { lat: number; lng: number; accuracy?: number | null } | null {
    // Validar que lat y lng existan y sean números finitos
    if (!Number.isFinite(data.lat) || !Number.isFinite(data.lng)) {
      console.warn('⚠️ Coordenada inválida: lat o lng no es un número finito', data);
      return null;
    }

    const lat = data.lat;
    const lng = data.lng;

    // Rechazar coordenadas (0, 0) - punto nulo
    if (lat === 0 && lng === 0) {
      console.warn('⚠️ Coordenada inválida: punto nulo (0, 0)', data);
      return null;
    }

    // Validar rangos de latitud y longitud
    if (lat < -90 || lat > 90) {
      console.warn('⚠️ Coordenada inválida: latitud fuera de rango', { lat, lng });
      return null;
    }

    if (lng < -180 || lng > 180) {
      console.warn('⚠️ Coordenada inválida: longitud fuera de rango', { lat, lng });
      return null;
    }

    // Validar accuracy si existe: descartar si es > 200 metros
    if (data.accuracy !== undefined && data.accuracy !== null) {
      if (!Number.isFinite(data.accuracy) || data.accuracy > 200) {
        console.warn('⚠️ Coordenada descartada: precisión GPS muy baja (>200m)', { lat, lng, accuracy: data.accuracy });
        return null;
      }
    }

    // Coordenada válida
    return {
      lat,
      lng,
      accuracy: data.accuracy
    };
  }

  /**
   * Pinta o actualiza la ubicación de un usuario en el mapa - ELIMINADO
   * Solo se mantiene el marcador local y draggable
   */

  /**
   * Abre el modal de login
   */
  abrirModalLogin(): void {
    this.modalLoginAbierto = true;
    this.loginError = '';
    this.loginUsuario = '';
    this.loginClave = '';
  }

  /**
   * Cierra el modal de login
   */
  cerrarModalLogin(): void {
    this.modalLoginAbierto = false;
    this.loginError = '';
    this.loginUsuario = '';
    this.loginClave = '';
    this.loginCargando = false;
  }

  /**
   * Inicia sesión con las credenciales ingresadas
   */
  iniciarSesion(): void {
    if (!this.loginUsuario || !this.loginClave) {
      this.loginError = 'Por favor, complete todos los campos';
      return;
    }

    this.loginCargando = true;
    this.loginError = '';

    const socket = this.socketService.getSocket();

    if (!socket || !socket.connected) {
      this.loginCargando = false;
      this.loginError = 'No hay conexión con el servidor. Intente nuevamente.';
      return;
    }

    // Escuchar respuesta del servidor (solo una vez)
    const respuestaHandler = (respuesta: { success: boolean; usuario?: any; error?: string }) => {
      this.loginCargando = false;

      if (respuesta.success && respuesta.usuario) {
        // Login exitoso
        this.usuarioLogueado = respuesta.usuario;
        this.mostrarAlerta(`Bienvenido, ${respuesta.usuario.usuario} (${respuesta.usuario.rol})`, 'success');
        this.cerrarModalLogin();
        
        console.log('✅ Login exitoso:', respuesta.usuario);
      } else {
        // Error en el login
        this.loginError = respuesta.error || 'Error al iniciar sesión';
        console.error('❌ Error en login:', respuesta.error);
      }

      // Remover el listener después de usarlo
      socket.off('login-respuesta', respuestaHandler);
    };

    // Escuchar respuesta del servidor
    socket.on('login-respuesta', respuestaHandler);

    // Enviar credenciales al servidor
    socket.emit('login', {
      usuario: this.loginUsuario.trim(),
      clave: this.loginClave
    });
  }

  /**
   * Cierra la sesión del usuario
   */
  cerrarSesion(): void {
    const socket = this.socketService.getSocket();
    const usuarioAnterior = this.usuarioLogueado?.usuario || 'Usuario';

    if (!socket || !socket.connected) {
      // Si no hay conexión, cerrar sesión localmente
      this.usuarioLogueado = null;
      this.mostrarAlerta(`Sesión cerrada. Hasta luego, ${usuarioAnterior}`, 'info');
      return;
    }

    // Escuchar respuesta del servidor (solo una vez)
    const respuestaHandler = (respuesta: { success: boolean; error?: string }) => {
      if (respuesta.success) {
        // Limpiar información del usuario
        this.usuarioLogueado = null;
        // Mostrar mensaje de confirmación
        this.mostrarAlerta(`Sesión cerrada. Hasta luego, ${usuarioAnterior}`, 'info');
        console.log('✅ Sesión cerrada');
      } else {
        // Error al cerrar sesión (aún así limpiar localmente)
        this.usuarioLogueado = null;
        this.mostrarAlerta('Sesión cerrada localmente', 'warning');
        console.warn('⚠️ Error al cerrar sesión en el servidor:', respuesta.error);
      }

      // Remover el listener después de usarlo
      socket.off('logout-respuesta', respuestaHandler);
    };

    // Escuchar respuesta del servidor
    socket.on('logout-respuesta', respuestaHandler);

    // Enviar evento de logout al servidor
    socket.emit('logout');
  }

  /**
   * Verifica el estado de los permisos de geolocalización
   */
  private async verificarPermisosGPS(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
    // Intentar usar la API de Permissions si está disponible
    if ('permissions' in navigator) {
      try {
        const result = await (navigator as any).permissions.query({ name: 'geolocation' });
        return result.state;
      } catch (error) {
        console.warn('No se pudo verificar permisos con Permissions API:', error);
        return 'unknown';
      }
    }
    return 'unknown';
  }

  /**
   * Valida y activa el GPS al iniciar la aplicación
   */
  private lastGpsErrorTime: number = 0;
  private lastGpsErrorCode: number | null = null;
  private readonly GPS_ERROR_THROTTLE_MS = 60000; // Solo mostrar el mismo error cada 60 segundos

  private async validarYActivarGPS(): Promise<void> {
    // Verificar si el navegador soporta geolocalización
    if (!navigator.geolocation) {
      this.mostrarModalGPS('Geolocalización no está soportada en este navegador');
      return;
    }

    // Verificar estado de permisos primero
    const estadoPermisos = await this.verificarPermisosGPS();
    
    // Si los permisos están denegados, mostrar mensaje específico
    if (estadoPermisos === 'denied') {
      this.mostrarModalGPS('Por favor, para conocer todos los lugares del mundo es necesario que actives el GPS con ubicación precisa. Por favor, permite el acceso a la ubicación PRECISA en la configuración de tu navegador o dispositivo.');
      this.gpsPermisoDenegado = true;
      return;
    }

    this.verificandoGPS = true;
    console.log('📍 Verificando permisos de ubicación precisa...');

    try {
      // Intentar obtener la posición actual (esto solicita permisos automáticamente si es necesario)
      const position = await this.geoService.getCurrentPosition();
      
      let me=this;
      //si LOS MARACDORES INICIALES  EL DRAGGABLE Y EL MARCADOR  REALTIME  ESTAN TAN NULOS O VACIOS  llmaar sus funciones para actualizarlos
      if(this.searchMarker==null || this.userLocationMarker==null){
        me.updateUserLocation(position);
        me.setupSearchMarker([position.lat, position.lng]);
        me.updateSearchQueryFromPosition(position);
        
        // Envío de ubicación vía socket - ELIMINADO (solo marcador local)      

      }

      // Reset error tracking cuando obtenemos una posición exitosa
      this.lastGpsErrorTime = 0;
      this.lastGpsErrorCode = null;

      this.gpsPermisoDenegado = false;
      this.modalGPSAbierto = false;
      this.verificandoGPS = false;
      this.gpsValidado = true;
      return; // Salir exitosamente
    } catch (error: any) {
      this.verificandoGPS = false;
      
      // Throttle de errores: solo mostrar modal si ha pasado suficiente tiempo desde el último error similar
      const now = Date.now();
      const shouldShowError = 
        this.lastGpsErrorCode !== error.code || 
        (now - this.lastGpsErrorTime) > this.GPS_ERROR_THROTTLE_MS;

      // Manejar diferentes tipos de errores
      let mensaje = 'Por favor, para conocer todos los lugares del mundo es necesario que actives el GPS';
      
      // Códigos de error de geolocalización:
      // 1 = PERMISSION_DENIED
      // 2 = POSITION_UNAVAILABLE
      // 3 = TIMEOUT
      if (error.code === 1 || error.message?.includes('permission') || error.message?.includes('denied')) {
        mensaje = 'Por favor, para conocer todos los lugares del mundo es necesario que actives el GPS. Por favor, permite el acceso a la ubicación en la configuración de tu navegador.';
        this.gpsPermisoDenegado = true;
      } else if (error.code === 2) {
        mensaje = 'No se pudo obtener tu ubicación. Por favor, verifica que el GPS esté activado en tu dispositivo.';
        this.gpsPermisoDenegado = false;
      } else if (error.code === 3) {
        // Para errores de timeout, solo loggear una vez y no mostrar modal repetidamente
        if (shouldShowError) {
          console.warn('⚠️ Timeout al obtener ubicación GPS. El seguimiento continuará intentando en segundo plano.');
        }
        // No mostrar modal para timeouts repetidos - el usuario puede usar la app sin GPS
        this.lastGpsErrorTime = now;
        this.lastGpsErrorCode = error.code;
        this.verificandoGPS = false;
        this.gpsValidado = true; // Marcar como validado para no bloquear la app
        return;
      }
      
      // Solo mostrar error en consola si no es timeout
      if (error.code !== 3 && shouldShowError) {
        console.warn('⚠️ Error al obtener ubicación:', error.code === 1 ? 'Permiso denegado' : error.code === 2 ? 'Ubicación no disponible' : error.message);
        this.mostrarModalGPS(mensaje);
      }
      
      this.lastGpsErrorTime = now;
      this.lastGpsErrorCode = error.code;
    }
  }

  /**
   * Muestra el modal de alerta de GPS
   */
  private mostrarModalGPS(mensaje: string): void {
    this.mensajeGPS = mensaje;
    this.modalGPSAbierto = true;
  }

  /**
   * Cierra el modal de GPS
   */
  cerrarModalGPS(): void {
    this.modalGPSAbierto = false;
    // Si el usuario cierra el modal sin dar permisos, marcar como validado para no mostrar de nuevo
    // (el usuario puede usar "Intentar de nuevo" si cambia de opinión)
    if (!this.gpsValidado && !this.verificandoGPS) {
      this.gpsValidado = true;
    }
  }

  /**
   * Intenta activar el GPS nuevamente
   */
  async intentarActivarGPS(): Promise<void> {
    if (this.verificandoGPS) {
      return; // Evitar múltiples intentos simultáneos
    }

    this.modalGPSAbierto = false;
    // Esperar un momento para que el modal se cierre visualmente
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Intentar validar nuevamente
    await this.validarYActivarGPS();
  }

  /**
   * Envía la ubicación en tiempo real a los demás clientes conectados - ELIMINADO
   * Solo se mantiene el marcador local y draggable
   */

  /**
   * Activa el Wake Lock para evitar que la pantalla se apague en dispositivos móviles
   * Compatible con Android Chrome y iOS Safari (iOS 16.4+)
   */
  private async activarWakeLock(): Promise<void> {
    // Verificar si la API de Wake Lock está disponible
    if (!navigator.wakeLock) {
      console.warn('⚠️ Wake Lock API no está disponible en este navegador');
      return;
    }

    try {
      // Solicitar Wake Lock de tipo 'screen'
      this.wakeLock = await navigator.wakeLock.request('screen');
      console.log('✅ Wake Lock activado - La pantalla permanecerá encendida');

      // Escuchar cuando el Wake Lock se libera (por ejemplo, cuando el usuario cambia de pestaña)
      this.wakeLock.addEventListener('release', () => {
        console.log('⚠️ Wake Lock liberado');
        // Intentar reactivarlo automáticamente cuando la página vuelve a estar visible
        document.addEventListener('visibilitychange', this.reactivarWakeLockOnVisible, { once: true });
      });
    } catch (error: any) {
      // Manejar errores comunes
      if (error.name === 'NotAllowedError') {
        console.warn('⚠️ Wake Lock denegado - El usuario debe interactuar con la página primero');
        // Intentar activar después de la primera interacción del usuario
        document.addEventListener('click', this.activarWakeLockOnInteraction, { once: true });
        document.addEventListener('touchstart', this.activarWakeLockOnInteraction, { once: true });
      } else if (error.name === 'NotSupportedError') {
        console.warn('⚠️ Wake Lock no soportado en este navegador');
      } else {
        console.error('❌ Error al activar Wake Lock:', error);
      }
    }
  }

  /**
   * Intenta activar Wake Lock después de la primera interacción del usuario
   */
  private activarWakeLockOnInteraction = async (): Promise<void> => {
    await this.activarWakeLock();
  };

  /**
   * Reactiva el Wake Lock cuando la página vuelve a estar visible
   */
  private reactivarWakeLockOnVisible = async (): Promise<void> => {
    if (document.visibilityState === 'visible' && !this.wakeLock) {
      // Esperar un pequeño delay antes de reactivar
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.activarWakeLock();
    }
  };

  /**
   * Desactiva el Wake Lock
   */
  private async desactivarWakeLock(): Promise<void> {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
        console.log('✅ Wake Lock desactivado');
      } catch (error) {
        console.error('❌ Error al desactivar Wake Lock:', error);
      }
    }
  }
}
