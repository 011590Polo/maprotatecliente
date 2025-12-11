import { Component, EventEmitter, Output } from '@angular/core';

@Component({
  selector: 'app-speed-dial',
  standalone: true,
  templateUrl: './speed-dial.component.html',
  styleUrl: './speed-dial.component.css',
})
export class SpeedDialComponent {
  open: boolean = false;
  @Output() layerChange = new EventEmitter<string>();
  @Output() openMarkerModal = new EventEmitter<void>();
  @Output() loadSavedMarkers = new EventEmitter<void>();
  @Output() miUbicacionClick = new EventEmitter<void>();
  @Output() centrarMapaClick = new EventEmitter<void>();

  // Claves de capas que existen en MapViewComponent.baseLayers
  private readonly capas: string[] = [
    'osmStandard',
    'osmHot',
    'osmTopo',
    'cartoPositron',
    'cartoDark',
  ];
  private indiceCapa: number = 0;

  toggleMenu(): void {
    this.open = !this.open;
  }

  centrarMapa(): void {
    // Emitir evento al componente padre para centrar el mapa en el marcador GPS real
    this.centrarMapaClick.emit();
  }

  /**
   * Emite evento cuando se hace clic en "Mi ubicación"
   * El componente padre (MapViewComponent) manejará la lógica
   */
  miUbicacion(): void {
    this.miUbicacionClick.emit();
  }

  abrirFiltros(): void {
    // TODO: abrir panel lateral o modal de filtros
    console.log('Acción: abrirFiltros()');
  }

  mostrarVehiculos(): void {
    // TODO: mostrar lista de vehículos
    console.log('Acción: mostrarVehiculos()');
  }

  cambiarEstilo(): void {
    // Selector de capas de mapa: rota entre capas y emite al padre (MapView)
    this.indiceCapa = (this.indiceCapa + 1) % this.capas.length;
    const capaSeleccionada = this.capas[this.indiceCapa];
    console.log('Cambiar capa de mapa a:', capaSeleccionada);
    this.layerChange.emit(capaSeleccionada);
  }

  abrirModalMarcador(): void {
    this.openMarkerModal.emit();
  }

  cargarMarcadoresGuardados(): void {
    this.loadSavedMarkers.emit();
  }
}


