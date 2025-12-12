import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { Marcador } from './api.service';
import { UserService } from './user.service';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private socket: Socket;
  private readonly serverUrl = environment.socketUrl;
  private userId: string | null = null;

  constructor(private userService: UserService) {
    // Configuración optimizada para MÁXIMA VELOCIDAD - Forzar WebSocket cuando sea posible
    this.socket = io(this.serverUrl, {
      transports: ['websocket', 'polling'], // Priorizar WebSocket para menor latencia
      upgrade: true,
      rememberUpgrade: true, // Recordar upgrade a WebSocket
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 10000, // Timeout más corto para conexión rápida
      autoConnect: true,
      forceNew: false,
      withCredentials: false
    });

    this.socket.on('connect', async () => {
      console.log('✅ Conectado al servidor Socket.IO', this.socket.id);
      
      // Obtener userId y enviarlo al servidor para registro
      try {
        this.userId = await this.userService.getUserId();
        const userInfo = this.userService.getUserInfo();
        
        // Enviar información del usuario al servidor
        this.socket.emit('usuario-conectado', {
          id: userInfo.id,
          nombre: userInfo.nombre,
          plataforma: userInfo.plataforma,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Error al obtener userId:', error);
      }
    });

    // Escuchar cuando el usuario se registra exitosamente para guardar num_usuario
    this.socket.on('usuario-registrado', (data: any) => {
      if (data.success && data.usuario && data.usuario.num_usuario) {
        this.userService.setUserNum(data.usuario.num_usuario);
      }
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('❌ Desconectado del servidor Socket.IO:', reason);
      
      // Emitir evento personalizado para que los componentes reaccionen
      window.dispatchEvent(new CustomEvent('socket-disconnected', { 
        detail: { reason } 
      }));
      
      if (reason === 'io server disconnect') {
        // El servidor desconectó el socket, necesitamos reconectar manualmente
        this.socket.connect();
      }
    });

    this.socket.on('connect_error', (error: Error) => {
      // Solo mostrar el error si no es un error de transporte común
      // Los errores de transporte son esperados y Socket.IO intentará reconectar automáticamente
      if (error.message && !error.message.includes('TransportError') && !error.message.includes('websocket error')) {
        console.warn('⚠️ Error de conexión Socket.IO:', error.message);
      }
      // El socket intentará reconectar automáticamente gracias a reconnection: true
    });

    this.socket.on('reconnect_attempt', (attemptNumber: number) => {
      console.log(`🔄 Intentando reconectar (intento ${attemptNumber})...`);
    });

    this.socket.on('reconnect', (attemptNumber: number) => {
      console.log(`✅ Reconexión exitosa después de ${attemptNumber} intentos`);
      
      // Emitir evento personalizado para que los componentes reaccionen
      window.dispatchEvent(new CustomEvent('socket-reconnected', { 
        detail: { attemptNumber } 
      }));
      
      // Reenviar información del usuario si existe
      try {
        const userInfo = this.userService.getUserInfo();
        if (userInfo && userInfo.id) {
          this.socket.emit('usuario-conectado', {
            id: userInfo.id,
            nombre: userInfo.nombre,
            plataforma: userInfo.plataforma,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error('❌ Error al reenviar información de usuario:', error);
      }
    });

    this.socket.on('reconnect_error', (error: Error) => {
      console.warn('⚠️ Error al intentar reconectar:', error.message);
    });

    this.socket.on('reconnect_failed', () => {
      console.error('❌ Falló la reconexión después de múltiples intentos');
    });
  }

  /**
   * Obtiene los marcadores iniciales cuando se conecta
   */
  onMarcadoresIniciales(): Observable<Marcador[]> {
    return new Observable(observer => {
      this.socket.on('marcadores:iniciales', (marcadores: Marcador[]) => {
        observer.next(marcadores);
      });
    });
  }

  /**
   * Escucha cuando se crea un nuevo marcador
   */
  onMarcadorCreado(): Observable<Marcador> {
    return new Observable(observer => {
      this.socket.on('marcador:creado', (marcador: Marcador) => {
        observer.next(marcador);
      });
    });
  }

  /**
   * Escucha cuando se actualiza un marcador
   */
  onMarcadorActualizado(): Observable<Marcador> {
    return new Observable(observer => {
      this.socket.on('marcador:actualizado', (marcador: Marcador) => {
        observer.next(marcador);
      });
    });
  }

  /**
   * Escucha cuando se elimina un marcador
   */
  onMarcadorEliminado(): Observable<{ id: string }> {
    return new Observable(observer => {
      this.socket.on('marcador:eliminado', (data: { id: string }) => {
        observer.next(data);
      });
    });
  }

  /**
   * Escucha nuevas coordenadas GPS - DESHABILITADO (solo marcador local)
   */
  // onCoordenadaNueva(): Observable<...> { ... }

  /**
   * Escucha cuando un cliente se conecta
   */
  onClienteConectado(): Observable<any> {
    return new Observable(observer => {
      this.socket.on('cliente-conectado', (data: any) => {
        observer.next(data);
      });
    });
  }

  /**
   * Escucha cuando un cliente se desconecta
   */
  onClienteDesconectado(): Observable<any> {
    return new Observable(observer => {
      this.socket.on('cliente-desconectado', (data: any) => {
        observer.next(data);
      });
    });
  }

  /**
   * Obtiene acceso directo al socket para eventos personalizados
   */
  getSocket(): Socket {
    return this.socket;
  }

  /**
   * Envía una actualización de coordenada GPS - DESHABILITADO (solo marcador local)
   */
  // enviarCoordenada(lat: number, lng: number, accuracy?: number): void { ... }

  /**
   * Obtiene el userId actual
   */
  getUserId(): string | null {
    return this.userId || this.userService.getUserIdSync();
  }

  /**
   * Desconecta el socket
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
    }
  }

  /**
   * Verifica si está conectado
   */
  isConnected(): boolean {
    return this.socket?.connected || false;
  }
}

