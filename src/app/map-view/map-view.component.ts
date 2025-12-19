import { AfterViewInit, Component, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy, NgZone } from '@angular/core';
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
  calculateDistance
} from '../utils/marker-utils';
// ELIMINADO: getBearing y rotateMarker - no se usan para marcadores de conductores (pueden causar saltos)

@Component({
  selector: 'app-map-view',
  standalone: true,
  imports: [SpeedDialComponent, NotificationsPanelComponent, NgIf, NgFor, FormsModule],
  templateUrl: './map-view.component.html',
  styleUrl: './map-view.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush // OPTIMIZACIÓN: OnPush para mejor rendimiento
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

  // Marcadores de conductores en tiempo real
  private conductoresMarkers: { [conductorId: string]: Marker } = {};
  private conductoresLastPositions = new Map<string, { lat: number; lng: number }>(); // Última posición para rotación
  // Mapa para asociar usuario con conductorId (para eliminar marcadores cuando se recibe notificación inactivo)
  private conductoresUsuarios: Map<string, string> = new Map(); // usuario -> conductorId
  // Mapa para rastrear última vez que se recibió ubicación de cada conductor (timestamp)
  private conductoresLastUpdate = new Map<string, number>(); // conductorId -> timestamp
  // Mapa para rastrear tiempos entre actualizaciones (para detectar señal irregular)
  private conductoresUpdateIntervals = new Map<string, number[]>(); // conductorId -> array de intervalos en ms
  // Mapa para almacenar el estado de señal de cada conductor
  private conductoresSignalState = new Map<string, 'buena' | 'regular' | 'mala'>(); // conductorId -> estado
  // Intervalo para verificar conductores desconectados
  private conductorTimeoutCheckInterval?: number;
  private iconCarroElement: HTMLElement;
  private conductorTrackingInitialized: boolean = false; // Flag para evitar listeners duplicados
  private conductorLocationHandler?: (data: any) => void; // Referencia al handler para poder removerlo

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
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone // OPTIMIZACIÓN: NgZone para actualizaciones fuera de Angular
  ) {
    // Crear elementos HTML para iconos de categorías
    this.categoryIcons = {
      'alerta': this.createCategoryIcon('#fbbf24', '⚠'),
      'peligro': this.createCategoryIcon('#ef4444', '🔥'),
      'informacion': this.createCategoryIcon('#3b82f6', 'ℹ'),
    };

    // Crear elemento HTML para icono de conductor tipo Waze
    this.iconCarroElement = this.createConductorIcon(40);
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
   * Crea un elemento HTML para icono de conductor tipo Waze (círculo con punto central)
   * @param size Tamaño del icono en píxeles
   * @param signalState Estado de la señal: 'buena' (verde), 'regular' (amarillo), 'mala' (rojo)
   */
  private createConductorIcon(size: number, signalState: 'buena' | 'regular' | 'mala' = 'buena'): HTMLElement {
    const el = document.createElement('div');
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.position = 'relative';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    
    // Determinar color según estado de señal
    let backgroundColor: string;
    let shadowColor: string;
    switch (signalState) {
      case 'buena':
        backgroundColor = '#3b82f6'; // Azul (normal)
        shadowColor = 'rgba(59, 130, 246, 0.3)';
        break;
      case 'regular':
        backgroundColor = '#f59e0b'; // Amarillo/Naranja (señal regular)
        shadowColor = 'rgba(245, 158, 11, 0.3)';
        break;
      case 'mala':
        backgroundColor = '#ef4444'; // Rojo (señal mala)
        shadowColor = 'rgba(239, 68, 68, 0.3)';
        break;
      default:
        backgroundColor = '#3b82f6';
        shadowColor = 'rgba(59, 130, 246, 0.3)';
    }
    
    // Círculo exterior (color según estado de señal)
    const outerCircle = document.createElement('div');
    outerCircle.style.width = `${size}px`;
    outerCircle.style.height = `${size}px`;
    outerCircle.style.borderRadius = '50%';
    outerCircle.style.backgroundColor = backgroundColor;
    outerCircle.style.border = '3px solid white';
    outerCircle.style.boxShadow = `0 2px 8px rgba(0,0,0,0.3), 0 0 0 2px ${shadowColor}`;
    outerCircle.style.position = 'absolute';
    outerCircle.style.top = '0';
    outerCircle.style.left = '0';
    
    // Círculo interior (punto central blanco)
    const innerCircle = document.createElement('div');
    const innerSize = size * 0.4; // 40% del tamaño total
    innerCircle.style.width = `${innerSize}px`;
    innerCircle.style.height = `${innerSize}px`;
    innerCircle.style.borderRadius = '50%';
    innerCircle.style.backgroundColor = 'white';
    innerCircle.style.boxShadow = '0 1px 3px rgba(0,0,0,0.2)';
    innerCircle.style.position = 'absolute';
    innerCircle.style.top = '50%';
    innerCircle.style.left = '50%';
    innerCircle.style.transform = 'translate(-50%, -50%)';
    innerCircle.style.zIndex = '1';
    
    // Agregar elementos al contenedor
    el.appendChild(outerCircle);
    el.appendChild(innerCircle);
    
    // SIN transiciones ni animaciones - actualización directa
    el.style.transition = 'none'; // Sin transiciones
    // SIN transiciones ni animaciones - actualización directa para evitar saltos
    el.style.transition = 'none';
    el.style.animation = 'none';
    el.style.cursor = 'pointer';
    
    return el;
  }

  ngAfterViewInit(): void {
    this.initMap();
    
    // Restaurar sesión del usuario desde localStorage
    this.restaurarSesion();
    
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
    // initConductoresTracking se llamará cuando el usuario inicie sesión como conductor
    // No inicializar aquí para evitar listeners innecesarios
    
    // Configurar listeners de conexión/desconexión del socket
    this.setupSocketConnectionListeners();
    
    // Listener para abrir modal de imagen desde popups
    this.imagePopupListener = (event: any) => {
      if (event.detail) {
        this.openImageModal(event.detail);
      }
    };
    window.addEventListener('openImageFromPopup', this.imagePopupListener);
  }
  
  /**
   * Restaura la sesión del usuario desde localStorage
   */
  private restaurarSesion(): void {
    try {
      const sesionGuardada = localStorage.getItem('sesionUsuario');
      if (sesionGuardada) {
        const sesionData = JSON.parse(sesionGuardada);
        const { usuario, token } = sesionData;
        
        if (!usuario || !token) {
          console.warn('⚠️ Datos de sesión incompletos');
          localStorage.removeItem('sesionUsuario');
          return;
        }
        
        console.log('✅ Sesión encontrada en localStorage:', usuario.usuario);
        
        // IMPORTANTE: Validar token en el servidor para restaurar sesión
        // Esperar a que el socket esté conectado
        const socket = this.socketService.getSocket();
        if (socket && socket.connected) {
          this.validarTokenSesion(token);
        } else {
          // Si el socket no está conectado, esperar a que se conecte
          console.log('⏳ Socket no conectado, esperando conexión para validar token...');
          const checkConnection = setInterval(() => {
            const socketCheck = this.socketService.getSocket();
            if (socketCheck && socketCheck.connected) {
              clearInterval(checkConnection);
              this.validarTokenSesion(token);
            }
          }, 500);
          
          // Timeout de seguridad: si no se conecta en 10 segundos, restaurar solo localmente
          setTimeout(() => {
            clearInterval(checkConnection);
            console.warn('⚠️ Timeout esperando conexión - restaurando sesión solo localmente');
            this.restaurarSesionLocal(usuario);
          }, 10000);
        }
      }
    } catch (error) {
      console.error('❌ Error al restaurar sesión:', error);
      // Limpiar localStorage si hay error
      localStorage.removeItem('sesionUsuario');
    }
  }
  
  /**
   * Valida el token de sesión en el servidor
   */
  private validarTokenSesion(token: string): void {
    const socket = this.socketService.getSocket();
    if (!socket || !socket.connected) {
      console.warn('⚠️ Socket no disponible para validar token');
      return;
    }
    
    console.log('🔄 Validando token de sesión en el servidor...');
    
    // Escuchar respuesta del servidor
    const respuestaHandler = (respuesta: { success: boolean; usuario?: any; error?: string }) => {
      socket.off('validar-token-respuesta', respuestaHandler);
      
      if (respuesta.success && respuesta.usuario) {
        console.log('✅ Token válido - Sesión restaurada:', respuesta.usuario.usuario);
        this.restaurarSesionLocal(respuesta.usuario);
      } else {
        console.warn('⚠️ Token inválido o expirado:', respuesta.error);
        // Limpiar sesión inválida
        localStorage.removeItem('sesionUsuario');
        this.mostrarAlerta('Tu sesión ha expirado. Por favor, inicia sesión nuevamente.', 'warning');
      }
    };
    
    socket.on('validar-token-respuesta', respuestaHandler);
    
    // Enviar token al servidor para validación
    socket.emit('validar-token', { token });
  }
  
  /**
   * Restaura la sesión solo localmente (sin hacer login en el servidor)
   */
  private restaurarSesionLocal(usuario: any): void {
    this.usuarioLogueado = usuario;
    console.log('✅ Sesión restaurada localmente:', usuario.usuario);
    
    // Inicializar recepción de ubicaciones de conductores
    if (!this.conductorTrackingInitialized) {
      console.log('👂 Inicializando recepción de ubicaciones de conductores (sesión restaurada)');
      this.initConductoresTracking();
    }
    
    // Si el usuario es conductor, reactivar transmisión
    if (usuario.rol === 'conductor') {
      console.log('🚗 Usuario conductor detectado - Reactivando transmisión');
      
      // Activar GPS si no está activo
      if (!this.geoService.isTracking()) {
        this.geoService.iniciarGPS().catch(error => {
          console.error('❌ Error al reactivar GPS:', error);
        });
      }
      
      // Iniciar transmisión después de un breve delay
      setTimeout(() => {
        this.geoService.iniciarTransmisionConductor();
      }, 500);
    }
    
    this.cdr.markForCheck();
  }

  /**
   * Configura listeners de conexión/desconexión del socket para conductores
   */
  private setupSocketConnectionListeners(): void {
    // Listener para desconexión
    window.addEventListener('socket-disconnected', (event: any) => {
      const reason = event.detail?.reason || 'Desconocido';
      console.warn('⚠️ Socket desconectado:', reason);
      
      // Si es conductor, avisar y detener transmisión
      if (this.usuarioLogueado?.rol === 'conductor') {
        this.mostrarAlerta('⚠️ Conexión perdida. La transmisión de ubicación se ha detenido.', 'warning');
        this.geoService.detenerTransmisionConductor();
        this.cdr.markForCheck();
      }
    });
    
    // Listener para reconexión
    window.addEventListener('socket-reconnected', (event: any) => {
      const attemptNumber = event.detail?.attemptNumber || 0;
      console.log('✅ Socket reconectado después de', attemptNumber, 'intentos');
      
      // IMPORTANTE: Para TODOS los roles, reinicializar recepción de ubicaciones de conductores
      // Esto asegura que se vuelvan a escuchar las ubicaciones después de la reconexión
      console.log('🔄 Reinicializando recepción de ubicaciones de conductores después de reconexión (para todos los roles)');
      
      // Reinicializar tracking de conductores (forceReinit = true para forzar reinicialización)
      // Esto remueve el listener anterior y registra uno nuevo
      this.initConductoresTracking(true);
      
      // Si es conductor, reanudar transmisión automáticamente
      if (this.usuarioLogueado?.rol === 'conductor') {
        console.log('🚗 Reconexión detectada - REANUDANDO TRANSMISIÓN para conductor');
        this.mostrarAlerta('✅ Conexión restaurada. Transmisión de ubicación reanudada automáticamente.', 'success');
        
        // PRINCIPIO RECTOR: Reanudar transmisión inmediatamente
        // El geoService automáticamente reenviará la última coordenada válida
        this.geoService.iniciarTransmisionConductor();
        
        // Asegurar que el GPS siga funcionando (no debería haberse detenido)
        if (!this.geoService.isTracking()) {
          console.log('📍 Reactivando GPS para conductor');
          this.geoService.iniciarGPS();
        }
      } else {
        // Para otros roles, solo mostrar notificación de reconexión
        this.mostrarAlerta('✅ Conexión restaurada. Recibiendo ubicaciones de conductores.', 'success');
      }
      
      this.cdr.markForCheck();
    });
  }

  /**
   * Limpia todos los marcadores de conductores del mapa
   */
  private limpiarMarcadoresConductores(): void {
    Object.values(this.conductoresMarkers).forEach(marker => {
      if (marker) {
        marker.remove();
      }
    });
    this.conductoresMarkers = {};
    this.conductoresLastPositions.clear();
    this.conductoresUsuarios.clear();
    this.conductoresLastUpdate.clear();
    this.conductoresUpdateIntervals.clear();
    this.conductoresSignalState.clear();
    console.log('🧹 Marcadores de conductores limpiados');
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    // Desactivar Wake Lock
    this.desactivarWakeLock();
    
    // Limpiar intervalo de verificación de timeout de conductores
    if (this.conductorTimeoutCheckInterval) {
      clearInterval(this.conductorTimeoutCheckInterval);
      this.conductorTimeoutCheckInterval = undefined;
    }
    
    // Remover listener de eventos personalizados
    if (this.imagePopupListener) {
      window.removeEventListener('openImageFromPopup', this.imagePopupListener);
    }
    
    // Remover listeners de socket
    window.removeEventListener('socket-disconnected', () => {});
    window.removeEventListener('socket-reconnected', () => {});
    
    // Detener geolocalización
    this.geoService.stopTracking();
    if (this.geoSubscription) {
      this.geoSubscription.unsubscribe();
    }

    // Cancelar animación si está activa
    if (this.smoothMoveAnimation) {
      cancelAnimationFrame(this.smoothMoveAnimation);
    }

    // Limpiar marcadores de conductores
    Object.values(this.conductoresMarkers).forEach(marker => {
      marker.remove();
    });
    this.conductoresMarkers = {};
    this.conductoresLastPositions.clear();
    this.conductoresLastUpdate.clear();

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

    // Limpiar todos los listeners de socket (usar una sola variable)
    const socket = this.socketService.getSocket();
    if (socket) {
      // Remover listener de ubicaciones de conductores
      if (this.conductorLocationHandler) {
        socket.off('ubicacion-conductor', this.conductorLocationHandler);
        this.conductorLocationHandler = undefined;
        this.conductorTrackingInitialized = false;
      }
      
      // Remover listeners de notificaciones de conductores
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
    this.cdr.markForCheck(); // Forzar detección de cambios

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
        this.cdr.markForCheck(); // Forzar detección de cambios
        return;
      }

      this.searchQuery = this.formatReverseAddress(data, lat, lng);
      this.searchResults = [];
      this.searchResultValid = true;
      this.cdr.markForCheck(); // Forzar detección de cambios
    } catch (error) {
      console.error('Error en reverse geocoding:', error);
      // En caso de error, mostrar coordenadas
      const lngLat = this.searchMarker!.getLngLat();
      this.searchQuery = `${lngLat.lat.toFixed(6)}, ${lngLat.lng.toFixed(6)}`;
      this.searchResultValid = true;
      this.searchError = null;
      this.cdr.markForCheck(); // Forzar detección de cambios
    } finally {
      this.searchInProgress = false;
      this.cdr.markForCheck(); // Forzar detección de cambios
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
    this.cdr.markForCheck(); // Forzar detección de cambios para mostrar el modal
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
    this.cdr.markForCheck(); // Forzar detección de cambios
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
    // VALIDACIÓN COMPLETA con mensajes de error claros
    if (!this.coordenadasMarcador) {
      this.mostrarAlerta('Error: No hay coordenadas seleccionadas. Por favor, arrastra el marcador en el mapa.', 'error');
      this.cdr.markForCheck();
      return;
    }

    if (!this.selectedCategory) {
      this.mostrarAlerta('Error: Debes seleccionar una categoría.', 'error');
      this.cdr.markForCheck();
      return;
    }

    const descripcionTrimmed = this.descripcionMarcador.trim();
    if (!descripcionTrimmed) {
      this.mostrarAlerta('Error: La descripción no puede estar vacía.', 'error');
      this.cdr.markForCheck();
      return;
    }

    if (descripcionTrimmed.length < 10) {
      this.mostrarAlerta('Error: La descripción debe tener al menos 10 caracteres.', 'error');
      this.cdr.markForCheck();
      return;
    }

    // Validar coordenadas válidas
    if (!Number.isFinite(this.coordenadasMarcador.lat) || !Number.isFinite(this.coordenadasMarcador.lng)) {
      this.mostrarAlerta('Error: Las coordenadas no son válidas.', 'error');
      this.cdr.markForCheck();
      return;
    }

    if (this.coordenadasMarcador.lat < -90 || this.coordenadasMarcador.lat > 90 || 
        this.coordenadasMarcador.lng < -180 || this.coordenadasMarcador.lng > 180) {
      this.mostrarAlerta('Error: Las coordenadas están fuera de rango válido.', 'error');
      this.cdr.markForCheck();
      return;
    }

    const marcadorData = {
      lat: this.coordenadasMarcador.lat,
      lng: this.coordenadasMarcador.lng,
      categoria: this.selectedCategory,
      descripcion: descripcionTrimmed
    };

    // Activar loading
    this.loadingVisible = true;
    this.loadingMensaje = 'Guardando marcador...';

    // Guardar en el servidor (enviar archivo como File, no Base64)
    this.apiService.createMarcador(marcadorData, this.archivoSeleccionado || undefined).subscribe({
      next: (response) => {
        this.loadingVisible = false;
        this.cdr.markForCheck(); // Forzar detección de cambios
        
        if (response.success && response.data) {
          console.log('Marcador guardado en servidor:', response.data);
          
          // IMPORTANTE: Guardar la posición actual del mapa y del marcador draggable
          // antes de cualquier operación para evitar que se muevan después de guardar
          const currentMapCenter = this.map?.getCenter();
          const currentMapZoom = this.map?.getZoom();
          const currentSearchMarkerPos = this.searchMarker?.getLngLat();
          
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
          
          // Cerrar modal y limpiar formulario DESPUÉS de mostrar el mensaje
          this.cerrarModalMarcador();
        } else {
          this.mostrarAlerta('Error al guardar: ' + (response.error || 'Error desconocido'), 'error');
          this.cdr.markForCheck();
        }
      },
      error: (error) => {
        this.loadingVisible = false;
        console.error('Error al guardar en servidor:', error);
        
        // Mensaje de error más descriptivo
        let mensajeError = 'Error al guardar el marcador. ';
        if (error.status === 0) {
          mensajeError += 'No se pudo conectar al servidor. Verifica que el servidor esté ejecutándose.';
        } else if (error.status === 400) {
          mensajeError += 'Datos inválidos: ' + (error.error?.error || 'Verifica los datos ingresados.');
        } else if (error.status === 500) {
          mensajeError += 'Error interno del servidor. Intenta nuevamente.';
        } else {
          mensajeError += 'Error de conexión. Intenta nuevamente.';
        }
        
        this.mostrarAlerta(mensajeError, 'error');
        this.cdr.markForCheck();
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

    // OPTIMIZACIÓN: Usar NgZone para actualizar fuera del ciclo de detección
    this.apiService.getMarcadores().subscribe({
      next: (response) => {
        // Ejecutar fuera de Angular para mejor rendimiento
        this.ngZone.runOutsideAngular(() => {
          if (response.success && response.data) {
            // Asignar datos
            this.marcadoresGuardados = response.data;
            
            // Ejecutar dentro de Angular solo para actualizar la vista
            this.ngZone.run(() => {
              this.cargandoMarcadores = false;
              this.loadingVisible = false;
              this.cdr.markForCheck(); // Forzar detección de cambios con OnPush
              
              if (this.marcadoresGuardados.length === 0) {
                this.mostrarAlerta('No hay marcadores guardados en el servidor', 'info');
              }
            });
          } else {
            this.ngZone.run(() => {
              this.cargandoMarcadores = false;
              this.loadingVisible = false;
              this.mostrarAlerta('Error al cargar marcadores: ' + (response.error || 'Error desconocido'), 'error');
            });
          }
        });
      },
      error: (error) => {
        this.ngZone.run(() => {
          this.cargandoMarcadores = false;
          this.loadingVisible = false;
          console.error('Error al cargar marcadores:', error);
          this.mostrarAlerta('Error al conectar con el servidor. Verifica que el servidor esté ejecutándose.', 'error');
        });
      }
    });
  }

  /**
   * Cierra el modal de gestión de marcadores
   */
  cerrarModalGestionMarcadores(): void {
    this.modalGestionMarcadoresAbierto = false;
    this.marcadoresGuardados = [];
    this.cdr.markForCheck(); // Forzar detección de cambios
  }

  /**
   * TrackBy function para optimizar *ngFor de marcadores
   */
  trackByMarcadorId(index: number, marcador: Marcador): string {
    return marcador.id || index.toString();
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

    // OPTIMIZACIÓN: Procesar marcadores en lotes usando requestAnimationFrame para mejor rendimiento
    const bounds: maplibregl.LngLatBounds = new maplibregl.LngLatBounds();
    const marcadores = this.marcadoresGuardados;
    const totalMarcadores = marcadores.length;
    let indiceActual = 0;
    const BATCH_SIZE = 50; // Procesar 50 marcadores por frame
    
    const procesarLote = () => {
      const finLote = Math.min(indiceActual + BATCH_SIZE, totalMarcadores);
      
      for (let i = indiceActual; i < finLote; i++) {
        const marcadorData = marcadores[i];
        const icono = this.categoryIcons[marcadorData.categoria];
        if (!icono) continue;

        // Clonar el elemento para cada marcador
        const iconoClone = icono.cloneNode(true) as HTMLElement;
        
        const marker = new Marker({
          element: iconoClone
        })
          .setLngLat([marcadorData.lng, marcadorData.lat])
          .addTo(this.map!);

        // OPTIMIZACIÓN: Crear popup de forma lazy (solo cuando se abre)
        const popup = new Popup({ offset: 25 });
        
        // Función para generar contenido del popup solo cuando se necesite
        const generarPopupContent = () => {
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
              // Escapar comillas y caracteres especiales para evitar problemas en el atributo onclick
              const escapedUrl = archivoUrl.replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n');
              // Usar un ID único para el marcador para poder identificar el clic
              const markerImageId = `marker-img-${marcadorData.id}`;
              popupContent += `
                <div style="margin-top: 8px;">
                  <img id="${markerImageId}" 
                       src="${archivoUrl}" 
                       alt="Imagen adjunta" 
                       class="w-20 h-20 object-cover rounded-md cursor-pointer marker-popup-image"
                       data-image-url="${escapedUrl}"
                       style="max-width: 200px; max-height: 150px; border-radius: 4px; object-fit: cover; display: block; cursor: pointer;"
                       onclick="event.stopPropagation(); const img = event.target; const url = img.getAttribute('data-image-url'); if (url) { window.dispatchEvent(new CustomEvent('openImageFromPopup', { detail: url })); }">
                </div>
              `;
            }
          }

          popupContent += `</div>`;
          return popupContent;
        };
        
        // Asignar popup con contenido lazy
        popup.setHTML(generarPopupContent());
        marker.setPopup(popup);
        
        // Agregar listener para clics en imágenes del popup después de que se cree
        // Esto asegura que el evento funcione correctamente
        marker.on('popupopen', () => {
          // Esperar un momento para que el DOM del popup esté completamente renderizado
          setTimeout(() => {
            const popupElement = marker.getPopup().getElement();
            if (popupElement) {
              const images = popupElement.querySelectorAll('.marker-popup-image');
              images.forEach((img: any) => {
                // Remover listener anterior si existe
                if (img._imageClickHandler) {
                  img.removeEventListener('click', img._imageClickHandler);
                }
                // Crear nuevo handler
                img._imageClickHandler = (e: Event) => {
                  e.stopPropagation();
                  const imageUrl = img.getAttribute('data-image-url');
                  if (imageUrl) {
                    this.openImageModal(imageUrl);
                  }
                };
                img.addEventListener('click', img._imageClickHandler);
              });
            }
          }, 100);
        });
        
        // Guardar datos del marcador para referencia
        (marker as any).marcadorData = marcadorData;
        
        this.savedMarkers.push(marker);
        bounds.extend([marcadorData.lng, marcadorData.lat]);
      }
      
      indiceActual = finLote;
      
      // Actualizar loading message
      if (indiceActual < totalMarcadores) {
        this.loadingMensaje = `Cargando marcadores... ${indiceActual}/${totalMarcadores}`;
        // Continuar procesando en el siguiente frame
        requestAnimationFrame(procesarLote);
      } else {
        // Terminado - ajustar vista del mapa
        this.finalizarCargaMarcadores(bounds, cantidad_marcadores);
      }
    };
    
    // Iniciar procesamiento
    procesarLote();
  }

  /**
   * Finaliza la carga de marcadores y ajusta la vista
   */
  private finalizarCargaMarcadores(bounds: maplibregl.LngLatBounds, cantidad_marcadores: number): void {
    // Ajustar vista del mapa SIN animación para mayor velocidad
    if (this.savedMarkers.length > 0 && bounds.getNorth() !== bounds.getSouth()) {
      this.map!.fitBounds(bounds, {
        padding: 50,
        duration: 0 // OPTIMIZACIÓN: Sin animación para mayor velocidad
      });
    }

    // Desactivar loading
    this.loadingVisible = false;
    this.cerrarModalGestionMarcadores();
    this.mostrarAlerta(`Se cargaron ${cantidad_marcadores} marcador(es) en el mapa`, 'success');

    // Inicializar listeners de socket para tiempo real (solo si hay marcadores cargados)
    this.initSocketListeners();
    
    // Forzar detección de cambios
    this.cdr.markForCheck();
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
        // Escapar comillas y caracteres especiales para evitar problemas en el atributo onclick
        const escapedUrl = archivoUrl.replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n');
        // Usar un ID único para el marcador para poder identificar el clic
        const markerImageId = `marker-img-${marcadorData.id}`;
        popupContent += `
          <div style="margin-top: 8px;">
            <img id="${markerImageId}" 
                 src="${archivoUrl}" 
                 alt="Imagen adjunta" 
                 class="w-20 h-20 object-cover rounded-md cursor-pointer marker-popup-image"
                 data-image-url="${escapedUrl}"
                 style="max-width: 200px; max-height: 150px; border-radius: 4px; object-fit: cover; display: block; cursor: pointer;"
                 onclick="event.stopPropagation(); const img = event.target; const url = img.getAttribute('data-image-url'); if (url) { window.dispatchEvent(new CustomEvent('openImageFromPopup', { detail: url })); }">
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
    
    // Agregar listener para clics en imágenes del popup después de que se cree
    // Esto asegura que el evento funcione correctamente
    marker.on('popupopen', () => {
      // Esperar un momento para que el DOM del popup esté completamente renderizado
      setTimeout(() => {
        const popupElement = marker.getPopup().getElement();
        if (popupElement) {
          const images = popupElement.querySelectorAll('.marker-popup-image');
          images.forEach((img: any) => {
            // Remover listener anterior si existe
            img.removeEventListener('click', img._imageClickHandler);
            // Crear nuevo handler
            img._imageClickHandler = (e: Event) => {
              e.stopPropagation();
              const imageUrl = img.getAttribute('data-image-url');
              if (imageUrl) {
                this.openImageModal(imageUrl);
              }
            };
            img.addEventListener('click', img._imageClickHandler);
          });
        }
      }, 100);
    });
    
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
    if (!imageUrl) {
      console.warn('⚠️ Intento de abrir modal de imagen sin URL');
      return;
    }
    // Decodificar URL si está codificada
    const decodedUrl = decodeURIComponent(imageUrl);
    this.selectedImage = decodedUrl;
    this.showImageModal = true;
    this.cdr.markForCheck(); // Forzar actualización de UI con OnPush
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
          
          // IMPORTANTE: Eliminar el marcador del conductor inactivo
          // Buscar el conductorId asociado al usuario
          const conductorId = this.conductoresUsuarios.get(data.usuario);
          if (conductorId && this.conductoresMarkers[conductorId]) {
            console.log(`🗑️ Eliminando marcador de conductor inactivo: ${data.usuario} (ID: ${conductorId})`);
            const marker = this.conductoresMarkers[conductorId];
            marker.remove();
            delete this.conductoresMarkers[conductorId];
            this.conductoresLastPositions.delete(conductorId);
            this.conductoresUsuarios.delete(data.usuario);
            this.cdr.markForCheck();
          } else {
            console.warn(`⚠️ No se encontró marcador para conductor inactivo: ${data.usuario}`);
          }
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
   * Valida y convierte coordenadas de manera estricta
   * SOLO acepta números válidos y los convierte explícitamente
   * Retorna { lat, lng } válidos o null si debe descartarse
   */
  private validarYConvertirCoordenadas(lat: any, lng: any): { lat: number; lng: number } | null {
    // CAPA 1: Verificar existencia
    if (lat === undefined || lat === null || lng === undefined || lng === null) {
      return null;
    }

    // CAPA 2: Intentar conversión a número (maneja strings numéricos)
    let latNum: number;
    let lngNum: number;

    // Convertir explícitamente a número
    if (typeof lat === 'string') {
      latNum = parseFloat(lat);
    } else if (typeof lat === 'number') {
      latNum = lat;
    } else {
      return null; // Tipo no soportado
    }

    if (typeof lng === 'string') {
      lngNum = parseFloat(lng);
    } else if (typeof lng === 'number') {
      lngNum = lng;
    } else {
      return null; // Tipo no soportado
    }

    // CAPA 3: Verificar que la conversión resultó en números finitos
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return null;
    }

    // CAPA 4: Rechazar punto nulo (0, 0)
    if (latNum === 0 && lngNum === 0) {
      return null;
    }

    // CAPA 5: Validar rangos estrictos
    if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      return null;
    }

    // CAPA 6: Verificar que no sean valores extremadamente pequeños (casi cero pero no exactamente cero)
    if (Math.abs(latNum) < 0.000001 && Math.abs(lngNum) < 0.000001) {
      return null;
    }

    // Coordenadas válidas
    return { lat: latNum, lng: lngNum };
  }

  /**
   * Sanitiza y valida coordenadas GPS estrictamente
   * Retorna coordenada válida o null si debe descartarse
   */
  private sanitizeLocation(data: { lat: number; lng: number; accuracy?: number | null }): { lat: number; lng: number; accuracy?: number | null } | null {
    // Usar la función de validación centralizada
    const coordenadasValidas = this.validarYConvertirCoordenadas(data.lat, data.lng);
    if (!coordenadasValidas) {
      return null;
    }

    // Validar accuracy si existe: descartar si es > 200 metros
    if (data.accuracy !== undefined && data.accuracy !== null) {
      const accuracyNum = typeof data.accuracy === 'string' ? parseFloat(data.accuracy) : data.accuracy;
      if (!Number.isFinite(accuracyNum) || accuracyNum > 200) {
        return null;
      }
      return {
        lat: coordenadasValidas.lat,
        lng: coordenadasValidas.lng,
        accuracy: accuracyNum
      };
    }

    return {
      lat: coordenadasValidas.lat,
      lng: coordenadasValidas.lng,
      accuracy: data.accuracy
    };
  }

  /**
   * Inicializa el sistema de tracking de conductores
   */
  /**
   * Inicializa el sistema de tracking de conductores
   * @param forceReinit - Si es true, fuerza la reinicialización incluso si ya estaba inicializado
   */
  private initConductoresTracking(forceReinit: boolean = false): void {
    // Evitar inicialización múltiple (a menos que se fuerce)
    if (this.conductorTrackingInitialized && !forceReinit) {
      console.warn('⚠️ initConductoresTracking ya fue inicializado, evitando duplicado');
      return;
    }

    const socket = this.socketService.getSocket();
    if (!socket) {
      console.error('❌ No se puede inicializar tracking de conductores: socket no disponible');
      return;
    }

    if (!socket.connected) {
      console.warn('⚠️ Socket no conectado - El tracking se activará al reconectar');
      // Aún así registrar el listener para cuando se reconecte
    }
    
    // Si se fuerza reinicialización, remover listener anterior para evitar duplicados
    if (forceReinit && this.conductorLocationHandler) {
      socket.off('ubicacion-conductor', this.conductorLocationHandler);
      console.log('🧹 Listener anterior de ubicacion-conductor removido para reinicialización');
    }
    
    // Crear handler una sola vez y guardar referencia
    // OPTIMIZACIÓN: Usar NgZone.run para actualizaciones fuera de Angular
    this.conductorLocationHandler = (data: any) => {
      //console.log('📥 Ubicación de conductor recibida:', data);
      // Ejecutar fuera de Angular para máxima velocidad
      this.ngZone.runOutsideAngular(() => {
        this.procesarUbicacionConductor(data);
      });
    };
    
    // Registrar listener
    socket.on('ubicacion-conductor', this.conductorLocationHandler);
    this.conductorTrackingInitialized = true;
    console.log('✅ Sistema de tracking de conductores inicializado - Listo para recibir ubicaciones');
    
    // Iniciar verificación periódica de conductores desconectados
    this.iniciarVerificacionTimeoutConductores();
  }
  
  /**
   * Inicia la verificación periódica de conductores que dejan de enviar ubicaciones
   * Verifica cada 2 segundos si algún conductor no ha enviado ubicaciones en los últimos 5 segundos
   */
  private iniciarVerificacionTimeoutConductores(): void {
    // Limpiar intervalo anterior si existe
    if (this.conductorTimeoutCheckInterval) {
      clearInterval(this.conductorTimeoutCheckInterval);
    }
    
    // Verificar cada 2 segundos para detección más rápida
    this.conductorTimeoutCheckInterval = window.setInterval(() => {
      this.verificarConductoresDesconectados();
    }, 2000); // Verificar cada 2 segundos
    
    console.log('✅ Verificación de timeout de conductores iniciada (cada 2 segundos, timeout de 5 segundos)');
  }
  
  /**
   * Verifica si algún conductor no ha enviado ubicaciones en los últimos 5 segundos
   * Si es así, lo considera desconectado y remueve su marcador
   */
  private verificarConductoresDesconectados(): void {
    const ahora = Date.now();
    const TIMEOUT_MS = 5000; // 5 segundos sin recibir ubicación = desconectado
    
    // Iterar sobre todos los conductores que tienen marcadores
    Object.keys(this.conductoresMarkers).forEach(conductorId => {
      const ultimaActualizacion = this.conductoresLastUpdate.get(conductorId);
      
      // Si no hay registro de última actualización, usar timestamp 0 (muy antiguo)
      if (!ultimaActualizacion) {
        // Si el marcador existe pero no hay registro de actualización, considerarlo desconectado
        console.warn(`⚠️ Conductor ${conductorId} no tiene registro de última actualización, removiendo marcador`);
        this.removerConductorDesconectado(conductorId);
        return;
      }
      
      const tiempoSinActualizacion = ahora - ultimaActualizacion;
      
      // Si no se ha recibido ubicación en los últimos 15 segundos, considerar desconectado
      if (tiempoSinActualizacion > TIMEOUT_MS) {
        const usuario = this.obtenerUsuarioPorConductorId(conductorId);
        console.warn(`⚠️ Conductor ${usuario || conductorId} no ha enviado ubicación en ${Math.round(tiempoSinActualizacion / 1000)}s, removiendo marcador`);
        this.removerConductorDesconectado(conductorId);
      }
    });
  }
  
  /**
   * Obtiene el nombre de usuario asociado a un conductorId
   */
  private obtenerUsuarioPorConductorId(conductorId: string): string | null {
    for (const [usuario, id] of this.conductoresUsuarios.entries()) {
      if (id === conductorId) {
        return usuario;
      }
    }
    return null;
  }
  
  /**
   * Remueve el marcador de un conductor desconectado y limpia sus datos
   */
  private removerConductorDesconectado(conductorId: string): void {
    const marker = this.conductoresMarkers[conductorId];
    if (marker) {
      marker.remove();
      delete this.conductoresMarkers[conductorId];
    }
    
    // Limpiar datos asociados
    this.conductoresLastPositions.delete(conductorId);
    this.conductoresLastUpdate.delete(conductorId);
    this.conductoresUpdateIntervals.delete(conductorId);
    this.conductoresSignalState.delete(conductorId);
    
    // Limpiar asociación usuario -> conductorId
    const usuario = this.obtenerUsuarioPorConductorId(conductorId);
    if (usuario) {
      this.conductoresUsuarios.delete(usuario);
      
      // Notificar al usuario que el conductor se desconectó
      this.mostrarAlerta(`Conductor ${usuario} desconectado (sin señal)`, 'warning');
      
      // Enviar notificación al servicio de notificaciones
      this.notificationService.pushNotification(`Conductor ${usuario} desconectado (sin señal)`, 'warning');
    }
    
    this.cdr.markForCheck();
  }
  
  /**
   * Calcula el estado de señal basado en el tiempo promedio entre actualizaciones
   * @param promedioIntervalo Tiempo promedio en milisegundos entre actualizaciones
   * @returns Estado de señal: 'buena', 'regular', o 'mala'
   */
  private calcularEstadoSenal(promedioIntervalo: number): 'buena' | 'regular' | 'mala' {
    // Si el promedio es menor a 1000ms (1 segundo), señal excelente
    if (promedioIntervalo <= 1000) {
      return 'buena';
    }
    // Si el promedio está entre 1000ms y 3000ms (1-3 segundos), señal regular
    if (promedioIntervalo <= 3000) {
      return 'regular';
    }
    // Si el promedio es mayor a 3000ms (3 segundos), señal mala
    return 'mala';
  }
  
  /**
   * Obtiene el texto descriptivo del estado de señal
   */
  private obtenerTextoEstadoSenal(estado: 'buena' | 'regular' | 'mala'): string {
    switch (estado) {
      case 'buena':
        return 'Buena';
      case 'regular':
        return 'Regular';
      case 'mala':
        return 'Mala';
      default:
        return 'Desconocida';
    }
  }
  
  /**
   * Obtiene el color para mostrar el estado de señal
   */
  private obtenerColorEstadoSenal(estado: 'buena' | 'regular' | 'mala'): string {
    switch (estado) {
      case 'buena':
        return '#10b981'; // Verde
      case 'regular':
        return '#f59e0b'; // Amarillo/Naranja
      case 'mala':
        return '#ef4444'; // Rojo
      default:
        return '#6b7280'; // Gris
    }
  }
  
  /**
   * Actualiza el color del marcador de un conductor según su estado de señal
   */
  private actualizarColorMarcadorConductor(conductorId: string, estadoSenal: 'buena' | 'regular' | 'mala'): void {
    const marker = this.conductoresMarkers[conductorId];
    if (!marker) {
      return;
    }
    
    const iconElement = marker.getElement();
    if (!iconElement) {
      return;
    }
    
    // Buscar el círculo exterior en el elemento del marcador
    const outerCircle = iconElement.querySelector('div') as HTMLElement;
    if (!outerCircle) {
      return;
    }
    
    // Determinar color según estado de señal
    let backgroundColor: string;
    let shadowColor: string;
    switch (estadoSenal) {
      case 'buena':
        backgroundColor = '#3b82f6'; // Azul
        shadowColor = 'rgba(59, 130, 246, 0.3)';
        break;
      case 'regular':
        backgroundColor = '#f59e0b'; // Amarillo/Naranja
        shadowColor = 'rgba(245, 158, 11, 0.3)';
        break;
      case 'mala':
        backgroundColor = '#ef4444'; // Rojo
        shadowColor = 'rgba(239, 68, 68, 0.3)';
        break;
      default:
        backgroundColor = '#3b82f6';
        shadowColor = 'rgba(59, 130, 246, 0.3)';
    }
    
    // Actualizar color del círculo exterior
    outerCircle.style.backgroundColor = backgroundColor;
    outerCircle.style.boxShadow = `0 2px 8px rgba(0,0,0,0.3), 0 0 0 2px ${shadowColor}`;
  }

  /**
   * Procesa ubicación de conductor - OPTIMIZADO para máxima velocidad
   */
  private procesarUbicacionConductor(data: any): void {
    try {
        // VALIDACIÓN ESTRICTA DE ESTRUCTURA DE DATOS
        if (!data || typeof data !== 'object') {
          console.warn('⚠️ Datos de ubicación de conductor inválidos: no es un objeto', data);
          return;
        }

        // Validar conductorId
        if (!data.conductorId || typeof data.conductorId !== 'string' || data.conductorId.trim() === '') {
          console.warn('⚠️ Datos de ubicación de conductor inválidos: conductorId faltante o inválido', data);
          return;
        }

        // Validar usuario
        if (!data.usuario || typeof data.usuario !== 'string' || data.usuario.trim() === '') {
          console.warn('⚠️ Datos de ubicación de conductor inválidos: usuario faltante o inválido', data);
          return;
        }

        // Verificar que no sea el usuario actual (el conductor no debe recibir su propia ubicación)
        if (this.usuarioLogueado && this.usuarioLogueado.usuario === data.usuario) {
          return; // Ignorar propia ubicación
        }

        // VALIDACIÓN ESTRICTA DE COORDENADAS USANDO FUNCIÓN CENTRALIZADA
        const coordenadasValidas = this.validarYConvertirCoordenadas(data.lat, data.lng);
        
        if (!coordenadasValidas) {
          console.warn(`⚠️ Coordenadas inválidas descartadas para conductor ${data.usuario}:`, { 
            lat: data.lat, 
            lng: data.lng, 
            tipoLat: typeof data.lat, 
            tipoLng: typeof data.lng 
          });
          return;
        }

        // Validar accuracy si existe
        if (data.accuracy !== undefined && data.accuracy !== null) {
          const accuracyNum = typeof data.accuracy === 'string' ? parseFloat(data.accuracy) : data.accuracy;
          if (!Number.isFinite(accuracyNum) || accuracyNum > 200) {
            console.warn(`⚠️ Precisión GPS muy baja para conductor ${data.usuario}:`, { accuracy: data.accuracy });
            return;
          }
        }

        // Crear objeto con coordenadas validadas y convertidas
        const datosValidados = {
          ...data,
          lat: coordenadasValidas.lat,
          lng: coordenadasValidas.lng
        };

        // Si llegamos aquí, los datos son válidos - procesar INMEDIATAMENTE
        // Ejecutar dentro de NgZone solo para actualizar marcador
        this.ngZone.run(() => {
          this.pintarOActualizarConductor(datosValidados);
        });
      } catch (error) {
        console.error('❌ Error al procesar ubicación de conductor:', error, data);
      }
  }

  /**
   * Pinta o actualiza la ubicación de un conductor en el mapa
   * IMPORTANTE: Esta función asume que los datos ya fueron validados en initConductoresTracking()
   */
  private pintarOActualizarConductor(data: { conductorId: string; usuario: string; lat: number; lng: number; speed: number; timestamp: number; accuracy?: number }): void {
    if (!this.map) {
      console.warn('⚠️ Mapa no inicializado, no se puede pintar conductor');
      return;
    }

    const { conductorId, usuario, speed } = data;

    // VALIDACIÓN FINAL USANDO FUNCIÓN CENTRALIZADA (doble verificación)
    const coordenadasValidas = this.validarYConvertirCoordenadas(data.lat, data.lng);
    
    if (!coordenadasValidas) {
      console.error(`❌ ERROR CRÍTICO: Coordenadas inválidas en pintarOActualizarConductor para ${usuario}:`, { 
        lat: data.lat, 
        lng: data.lng,
        tipoLat: typeof data.lat,
        tipoLng: typeof data.lng
      });
      return;
    }

    // Extraer valores finales (ya validados y convertidos)
    const finalLat = coordenadasValidas.lat;
    const finalLng = coordenadasValidas.lng;
    const newPos = { lat: finalLat, lng: finalLng };
    const newLngLat: [number, number] = [finalLng, finalLat]; // MapLibre usa [lng, lat]

    // Si no existe el marcador, crearlo
    if (!this.conductoresMarkers[conductorId]) {
      // VALIDACIÓN FINAL antes de crear
      if (!Number.isFinite(finalLat) || !Number.isFinite(finalLng)) {
        console.error(`❌ ERROR CRÍTICO: No se puede crear marcador - coordenadas inválidas para ${usuario}`);
        return;
      }

      try {
        // Obtener estado de señal inicial (o 'buena' por defecto)
        const estadoSenal = this.conductoresSignalState.get(conductorId) || 'buena';
        
        // Crear icono tipo Waze para el conductor con el color según estado de señal
        const iconElement = this.createConductorIcon(40, estadoSenal);
        
        // Asegurar que el elemento tenga dimensiones válidas
        iconElement.style.width = '40px';
        iconElement.style.height = '40px';
        iconElement.style.position = 'relative';
        iconElement.style.display = 'flex';
        iconElement.style.alignItems = 'center';
        iconElement.style.justifyContent = 'center';
        // SIN transiciones ni animaciones - actualización directa
        iconElement.style.transition = 'none';
        iconElement.style.animation = 'none';
        // SIN transiciones ni animaciones - actualización directa
        iconElement.style.transition = 'none';
        iconElement.style.animation = 'none';

        // Crear marcador con ancla en el centro
        const marker = new Marker({
          element: iconElement,
          anchor: 'center' // Anclar en el centro del icono
        });

        // VALIDACIÓN FINAL de coordenadas antes de establecer posición
        if (!Number.isFinite(finalLat) || !Number.isFinite(finalLng)) {
          console.error(`❌ ERROR: Coordenadas no finitas al crear marcador para ${usuario}`, { finalLat, finalLng });
          return;
        }

        // VALIDACIÓN EXTRA: Verificar que newLngLat sea un array válido
        if (!Array.isArray(newLngLat) || newLngLat.length !== 2) {
          console.error(`❌ ERROR: newLngLat no es un array válido para ${usuario}:`, newLngLat);
          return;
        }

        // VALIDACIÓN EXTRA: Verificar que los valores del array sean números finitos
        if (!Number.isFinite(newLngLat[0]) || !Number.isFinite(newLngLat[1])) {
          console.error(`❌ ERROR: Valores en newLngLat no son finitos para ${usuario}:`, newLngLat);
          return;
        }

        // VALIDACIÓN EXTRA: Verificar que no sean (0, 0)
        if (newLngLat[0] === 0 && newLngLat[1] === 0) {
          console.error(`❌ ERROR: newLngLat es (0, 0) para ${usuario}`);
          return;
        }

        // Establecer posición ANTES de agregar al mapa (esto es crítico)
        try {
          marker.setLngLat(newLngLat);
          
          // VERIFICACIÓN POST-SET: Verificar que la posición se estableció correctamente
          const posVerificada = marker.getLngLat();
          if (!posVerificada || 
              !Number.isFinite(posVerificada.lat) || 
              !Number.isFinite(posVerificada.lng) ||
              (posVerificada.lat === 0 && posVerificada.lng === 0)) {
            console.error(`❌ ERROR CRÍTICO: Posición inválida después de setLngLat inicial para ${usuario}:`, { 
              esperado: newLngLat, 
              obtenido: posVerificada 
            });
            return;
          }
        } catch (error) {
          console.error(`❌ ERROR al establecer posición inicial del marcador para ${usuario}:`, error, { newLngLat, finalLat, finalLng });
          return;
        }
        
        // Agregar al mapa
        marker.addTo(this.map);

        // Guardar referencia
        this.conductoresMarkers[conductorId] = marker;
        // Guardar asociación usuario -> conductorId para poder eliminar cuando se recibe notificación inactivo
        this.conductoresUsuarios.set(usuario, conductorId);
        
        // Agregar popup con información del conductor
        // IMPORTANTE: closeOnClick: false y closeOnMove: false para que no se cierre automáticamente
        const speedKmh = (speed && Number.isFinite(speed)) ? (speed * 3.6).toFixed(1) : '0.0';
        const estadoSenalInicial = this.conductoresSignalState.get(conductorId) || 'buena';
        const estadoSenalTextoInicial = this.obtenerTextoEstadoSenal(estadoSenalInicial);
        const colorSenalInicial = this.obtenerColorEstadoSenal(estadoSenalInicial);
        const popup = new Popup({ 
          offset: 25,
          closeOnClick: false, // No cerrar al hacer clic en el mapa
          closeOnMove: false, // No cerrar al mover el mapa
          closeButton: true, // Mostrar botón de cerrar
          maxWidth: '300px'
        })
          .setHTML(`
            <div style="min-width: 150px; pointer-events: auto;" onclick="event.stopPropagation();">
              <strong>🚗 Conductor: ${usuario}</strong><br>
              <small>Velocidad: ${speedKmh} km/h</small><br>
              <small style="color: ${colorSenalInicial}; font-weight: bold;">📶 Señal: ${estadoSenalTextoInicial}</small>
            </div>
          `);
        
        // Prevenir que el popup se cierre al hacer clic en el mapa
        marker.setPopup(popup);
        
        // Agregar listener para prevenir el cierre del popup
        marker.on('click', (e) => {
          e.originalEvent?.stopPropagation();
        });
        
        // Guardar última posición válida para rotación
        this.conductoresLastPositions.set(conductorId, newPos);
        
        // Registrar timestamp de creación (para detección de desconexión)
        const ahora = Date.now();
        this.conductoresLastUpdate.set(conductorId, ahora);
        
        // Inicializar estado de señal como "buena" para nuevo conductor
        this.conductoresSignalState.set(conductorId, 'buena');
        
        console.log(`✅ Marcador de conductor creado: ${usuario} en [${finalLat}, ${finalLng}]`);
      } catch (error) {
        console.error(`❌ Error al crear marcador de conductor ${usuario}:`, error);
        // No crear el marcador si hay error
        return;
      }
    } else {
      // Actualizar marcador existente
      const marker = this.conductoresMarkers[conductorId];
      
      // Obtener última posición válida
      const lastPos = this.conductoresLastPositions.get(conductorId);
      
      // VALIDACIÓN FINAL antes de actualizar
      if (!Number.isFinite(finalLat) || !Number.isFinite(finalLng)) {
        console.error(`❌ ERROR CRÍTICO: No se puede actualizar marcador - coordenadas inválidas para ${usuario}`, { finalLat, finalLng });
        // NO actualizar si las coordenadas son inválidas - mantener última posición válida
        return;
      }

      try {

        // Verificar que el marcador existe y es válido
        if (!marker || !marker.getElement()) {
          console.error(`❌ ERROR: Marcador no válido para ${usuario}`);
          return;
        }

        // Actualizar posición del marcador DIRECTAMENTE sin animaciones ni suavizado
        // ACTUALIZACIÓN INSTANTÁNEA - SIN INTERPOLACIÓN, SIN ANIMACIONES, SIN SUAVIZADO
        try {
          marker.setLngLat(newLngLat);
          
          // Verificar que la posición se estableció correctamente
          const currentLngLat = marker.getLngLat();
          if (!currentLngLat || 
              !Number.isFinite(currentLngLat.lat) || 
              !Number.isFinite(currentLngLat.lng) ||
              currentLngLat.lat === 0 && currentLngLat.lng === 0) {
            console.error(`❌ ERROR: Posición inválida después de setLngLat para ${usuario}`, { currentLngLat, expected: newLngLat });
            // Revertir a última posición válida si existe
            if (lastPos && Number.isFinite(lastPos.lat) && Number.isFinite(lastPos.lng)) {
              marker.setLngLat([lastPos.lng, lastPos.lat]);
            }
            return;
          }
        } catch (error) {
          console.error(`❌ ERROR al actualizar posición del marcador para ${usuario}:`, error, { newLngLat, finalLat, finalLng });
          // Revertir a última posición válida si existe
          if (lastPos && Number.isFinite(lastPos.lat) && Number.isFinite(lastPos.lng)) {
            try {
              marker.setLngLat([lastPos.lng, lastPos.lat]);
            } catch (revertError) {
              console.error(`❌ ERROR al revertir posición para ${usuario}:`, revertError);
            }
          }
          return;
        }
        
        // ELIMINADO: Rotación y cálculo de bearing - puede causar problemas y saltos
        // NO aplicar rotación para evitar interferencias con la posición
        
        // Actualizar última posición válida SOLO si la actualización fue exitosa
        this.conductoresLastPositions.set(conductorId, newPos);
        
        // Actualizar timestamp de última actualización (para detección de desconexión)
        const ahora = Date.now();
        const ultimaActualizacion = this.conductoresLastUpdate.get(conductorId);
        this.conductoresLastUpdate.set(conductorId, ahora);
        
        // Calcular intervalo entre actualizaciones (para detectar señal irregular)
        if (ultimaActualizacion) {
          const intervalo = ahora - ultimaActualizacion;
          let intervalos = this.conductoresUpdateIntervals.get(conductorId) || [];
          intervalos.push(intervalo);
          
          // Mantener solo los últimos 10 intervalos para calcular promedio
          if (intervalos.length > 10) {
            intervalos = intervalos.slice(-10);
          }
          
          this.conductoresUpdateIntervals.set(conductorId, intervalos);
          
          // Calcular estado de señal basado en el promedio de intervalos
          const promedioIntervalo = intervalos.reduce((a, b) => a + b, 0) / intervalos.length;
          const estadoSenal = this.calcularEstadoSenal(promedioIntervalo);
          this.conductoresSignalState.set(conductorId, estadoSenal);
          
          // Actualizar color del marcador si cambió el estado de señal
          this.actualizarColorMarcadorConductor(conductorId, estadoSenal);
        } else {
          // Primera actualización, establecer estado inicial como "buena"
          this.conductoresSignalState.set(conductorId, 'buena');
        }
        
        // Obtener estado de señal actual para actualización
        const estadoSenalActual = this.conductoresSignalState.get(conductorId) || 'buena';
        const estadoSenalTextoActual = this.obtenerTextoEstadoSenal(estadoSenalActual);
        const colorSenalActual = this.obtenerColorEstadoSenal(estadoSenalActual);
        
        // CRÍTICO: NO recrear el popup - solo actualizar su contenido si ya existe
        // Esto evita que se cierre el popup cuando el usuario lo tiene abierto
        const popupExistente = marker.getPopup();
        if (popupExistente) {
          // Solo actualizar el contenido HTML del popup existente
          const speedKmh = (speed && Number.isFinite(speed)) ? (speed * 3.6).toFixed(1) : '0.0';
          popupExistente.setHTML(`
            <div style="min-width: 150px; pointer-events: auto;" onclick="event.stopPropagation();">
              <strong>🚗 Conductor: ${usuario}</strong><br>
              <small>Velocidad: ${speedKmh} km/h</small><br>
              <small style="color: ${colorSenalActual}; font-weight: bold;">📶 Señal: ${estadoSenalTextoActual}</small>
            </div>
          `);
        } else {
          // Solo crear popup si no existe (primera vez)
          const speedKmh = (speed && Number.isFinite(speed)) ? (speed * 3.6).toFixed(1) : '0.0';
          const popup = new Popup({ 
            offset: 25,
            closeOnClick: false, // No cerrar al hacer clic en el mapa
            closeOnMove: false, // No cerrar al mover el mapa
            closeButton: true, // Mostrar botón de cerrar
            maxWidth: '300px'
          })
            .setHTML(`
              <div style="min-width: 150px; pointer-events: auto;" onclick="event.stopPropagation();">
                <strong>🚗 Conductor: ${usuario}</strong><br>
                <small>Velocidad: ${speedKmh} km/h</small>
              </div>
            `);
          
          marker.setPopup(popup);
          
          // Agregar listener para prevenir el cierre del popup (solo una vez)
          marker.on('click', (e) => {
            e.originalEvent?.stopPropagation();
          });
        }
      } catch (error) {
        console.error(`❌ Error al actualizar marcador de conductor ${usuario}:`, error);
        // NO actualizar si hay error - mantener última posición válida
        return;
      }
    }
  }

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

    // Timeout de seguridad: si no hay respuesta en 10 segundos, cancelar
    const timeoutId = setTimeout(() => {
      this.loginCargando = false;
      this.loginError = 'Tiempo de espera agotado. Verifique su conexión e intente nuevamente.';
      socket.off('login-respuesta', respuestaHandler);
      this.cdr.markForCheck();
      console.error('⏱️ Timeout en login - No se recibió respuesta del servidor');
    }, 10000); // 10 segundos

    // Escuchar respuesta del servidor (solo una vez)
    const respuestaHandler = (respuesta: { success: boolean; usuario?: any; token?: string; error?: string }) => {
      // Cancelar timeout si se recibió respuesta
      clearTimeout(timeoutId);
      this.loginCargando = false;

      if (respuesta.success && respuesta.usuario) {
        // Login exitoso
        this.usuarioLogueado = respuesta.usuario;
        
        // Guardar sesión (usuario + token) en localStorage para persistencia
        try {
          const sesionData = {
            usuario: respuesta.usuario,
            token: respuesta.token || '' // Guardar token de sesión
          };
          localStorage.setItem('sesionUsuario', JSON.stringify(sesionData));
          console.log('💾 Sesión y token guardados en localStorage');
        } catch (error) {
          console.warn('⚠️ No se pudo guardar la sesión en localStorage:', error);
        }
        
        this.mostrarAlerta(`Bienvenido, ${respuesta.usuario.usuario} (${respuesta.usuario.rol})`, 'success');
        this.cerrarModalLogin();
        
        // IMPORTANTE: TODOS los usuarios deben recibir ubicaciones de conductores
        // Inicializar recepción de ubicaciones de conductores (para visitantes, trabajadores, etc.)
        if (!this.conductorTrackingInitialized) {
          console.log('👂 Inicializando recepción de ubicaciones de conductores');
          this.initConductoresTracking();
        }
        
        // Si el usuario es conductor, iniciar transmisión de ubicación propia
        if (respuesta.usuario.rol === 'conductor') {
          console.log('🚗 Usuario es conductor - ACTIVANDO SISTEMA COMPLETO DE TRACKING');
          
          // PRIORIDAD 1: Asegurar que el GPS esté activo (watchPosition)
          // El GPS debe estar funcionando SIEMPRE, incluso sin conexión
          if (!this.geoService.isTracking()) {
            console.log('📍 Activando GPS para conductor');
            this.geoService.iniciarGPS().catch(error => {
              console.error('❌ Error al activar GPS:', error);
            });
          } else {
            console.log('✅ GPS ya está activo');
          }
          
          // PRIORIDAD 2: Iniciar transmisión de ubicación propia
          // Esto activa el sistema de envío continuo y resiliente
          // Esperar un momento para asegurar que el GPS esté listo
          setTimeout(() => {
            this.geoService.iniciarTransmisionConductor();
          }, 500);
          
          // Asegurar que el socket esté conectado
          if (socket.connected) {
            console.log('✅ Socket conectado - Sistema de tracking activo');
          } else {
            console.warn('⚠️ Socket no conectado - El GPS seguirá funcionando y se reanudará al reconectar');
          }
          
          this.mostrarAlerta('🚗 Modo conductor activado - Transmitiendo ubicación en tiempo real', 'success');
        } else {
          console.log(`✅ Usuario ${respuesta.usuario.rol} logueado - Recibiendo ubicaciones de conductores`);
        }
        
        console.log('✅ Login exitoso:', respuesta.usuario);
      } else {
        // Error en el login
        this.loginError = respuesta.error || 'Error al iniciar sesión';
        console.error('❌ Error en login:', respuesta.error);
      }

      // Remover el listener después de usarlo
      socket.off('login-respuesta', respuestaHandler);
      this.cdr.markForCheck();
    };

    // IMPORTANTE: Registrar el listener ANTES de enviar el evento
    // Escuchar respuesta del servidor
    socket.on('login-respuesta', respuestaHandler);
    
    console.log('👂 Listener de login-respuesta registrado');

    // Enviar credenciales al servidor
    console.log('📤 Enviando credenciales de login al servidor...', {
      usuario: this.loginUsuario.trim(),
      socketConnected: socket.connected,
      socketId: socket.id
    });
    
    try {
      socket.emit('login', {
        usuario: this.loginUsuario.trim(),
        clave: this.loginClave
      });
      console.log('✅ Evento login emitido correctamente');
    } catch (error) {
      console.error('❌ Error al emitir evento login:', error);
      clearTimeout(timeoutId);
      this.loginCargando = false;
      this.loginError = 'Error al enviar credenciales. Intente nuevamente.';
      socket.off('login-respuesta', respuestaHandler);
      this.cdr.markForCheck();
      return;
    }
    
    // Forzar detección de cambios
    this.cdr.markForCheck();
  }

  /**
   * Cierra la sesión del usuario
   */
  cerrarSesion(): void {
    const socket = this.socketService.getSocket();
    const usuarioAnterior = this.usuarioLogueado?.usuario || 'Usuario';

    // Limpiar sesión de localStorage
    try {
      localStorage.removeItem('sesionUsuario');
      console.log('🗑️ Sesión y token eliminados de localStorage');
    } catch (error) {
      console.warn('⚠️ Error al eliminar sesión de localStorage:', error);
    }

    if (!socket || !socket.connected) {
      // Si no hay conexión, cerrar sesión localmente
      this.usuarioLogueado = null;
      this.mostrarAlerta(`Sesión cerrada. Hasta luego, ${usuarioAnterior}`, 'info');
      return;
    }

    // Escuchar respuesta del servidor (solo una vez)
    const respuestaHandler = (respuesta: { success: boolean; error?: string }) => {
      if (respuesta.success) {
        // Si era conductor, detener transmisión de ubicación y limpiar marcadores
        if (this.usuarioLogueado?.rol === 'conductor') {
          console.log('🚗 Usuario conductor cerrando sesión - DETENIENDO TRANSMISIÓN');
          
          // Detener transmisión (pero NO el GPS - puede seguir funcionando para otros usos)
          this.geoService.detenerTransmisionConductor();
          
          // Limpiar marcadores de otros conductores
          this.limpiarMarcadoresConductores();
          
          this.mostrarAlerta('🛑 Modo conductor desactivado - Transmisión detenida', 'info');
        }
        
        // Limpiar información del usuario
        this.usuarioLogueado = null;
        // Limpiar sesión de localStorage (por si acaso)
        try {
          localStorage.removeItem('usuarioLogueado');
        } catch (error) {
          console.warn('⚠️ Error al eliminar sesión de localStorage:', error);
        }
        // Mostrar mensaje de confirmación
        this.mostrarAlerta(`Sesión cerrada. Hasta luego, ${usuarioAnterior}`, 'info');
        console.log('✅ Sesión cerrada');
      } else {
        // Error al cerrar sesión (aún así limpiar localmente)
        if (this.usuarioLogueado?.rol === 'conductor') {
          console.log('🚗 Usuario conductor - Deteniendo transmisión (error en logout)');
          this.geoService.detenerTransmisionConductor();
          this.limpiarMarcadoresConductores();
        }
        this.usuarioLogueado = null;
        // Limpiar sesión de localStorage (por si acaso)
        try {
          localStorage.removeItem('sesionUsuario');
        } catch (error) {
          console.warn('⚠️ Error al eliminar sesión de localStorage:', error);
        }
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
