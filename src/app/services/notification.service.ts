import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface Notification {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
  timestamp: Date;
  read: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private notifications: Notification[] = [];
  private notificationsSubject = new BehaviorSubject<Notification[]>([]);
  public notifications$: Observable<Notification[]> = this.notificationsSubject.asObservable();

  constructor() {
    // Cargar notificaciones del localStorage si existen
    this.loadFromLocalStorage();
  }

  /**
   * Agrega una nueva notificación
   */
  pushNotification(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
    const notification: Notification = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      message,
      type,
      timestamp: new Date(),
      read: false
    };

    this.notifications.unshift(notification); // Agregar al inicio
    
    // Limitar a las últimas 50 notificaciones
    if (this.notifications.length > 50) {
      this.notifications = this.notifications.slice(0, 50);
    }

    this.saveToLocalStorage();
    this.notificationsSubject.next([...this.notifications]);
  }

  /**
   * Obtiene todas las notificaciones
   */
  getNotifications(): Observable<Notification[]> {
    return this.notifications$;
  }

  /**
   * Obtiene las notificaciones no leídas
   */
  getUnreadCount(): number {
    return this.notifications.filter(n => !n.read).length;
  }

  /**
   * Marca una notificación como leída
   */
  markAsRead(id: string): void {
    const notification = this.notifications.find(n => n.id === id);
    if (notification && !notification.read) {
      notification.read = true;
      this.saveToLocalStorage();
      this.notificationsSubject.next([...this.notifications]);
    }
  }

  /**
   * Marca todas las notificaciones como leídas
   */
  markAllAsRead(): void {
    let changed = false;
    this.notifications.forEach(n => {
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    });

    if (changed) {
      this.saveToLocalStorage();
      this.notificationsSubject.next([...this.notifications]);
    }
  }

  /**
   * Limpia todas las notificaciones
   */
  clearAll(): void {
    this.notifications = [];
    this.saveToLocalStorage();
    this.notificationsSubject.next([]);
  }

  /**
   * Elimina una notificación específica
   */
  removeNotification(id: string): void {
    this.notifications = this.notifications.filter(n => n.id !== id);
    this.saveToLocalStorage();
    this.notificationsSubject.next([...this.notifications]);
  }

  /**
   * Guarda las notificaciones en localStorage
   */
  private saveToLocalStorage(): void {
    try {
      localStorage.setItem('notifications', JSON.stringify(this.notifications));
    } catch (error) {
      console.error('Error al guardar notificaciones en localStorage:', error);
    }
  }

  /**
   * Carga las notificaciones desde localStorage
   */
  private loadFromLocalStorage(): void {
    try {
      const stored = localStorage.getItem('notifications');
      if (stored) {
        const parsed = JSON.parse(stored);
        // Convertir timestamps a objetos Date
        this.notifications = parsed.map((n: any) => ({
          ...n,
          timestamp: new Date(n.timestamp)
        }));
        this.notificationsSubject.next([...this.notifications]);
      }
    } catch (error) {
      console.error('Error al cargar notificaciones desde localStorage:', error);
    }
  }
}





