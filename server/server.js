import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  initDatabase,
  getAllMarcadores,
  getMarcadorById,
  createMarcador,
  updateMarcador,
  deleteMarcador,
  saveCoordenadaGPS,
  getUltimasCoordenadas,
  getCoordenadasPorRango,
  getEstadisticasMarcadores,
  registrarOActualizarUsuario,
  getUsuarioById,
  getUsuariosConectados,
  closeDatabase
} from './database.js';
import { upload, getFileUrl, deleteFile } from './utils/fileUpload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);

// Configuración desde variables de entorno
const PORT = process.env.PORT || 3000;
const CORS_ORIGINS = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:4200', 'http://127.0.0.1:4200', 'http://localhost:4401', 'http://127.0.0.1:4401'];
const JSON_LIMIT = process.env.JSON_LIMIT || '10mb';
const NODE_ENV = process.env.NODE_ENV || 'development';

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    // Permitir requests sin origen (como mobile apps o Postman)
    if (!origin) return callback(null, true);
    
    // Verificar si el origen está en la lista permitida
    if (CORS_ORIGINS.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`⚠️  Origen CORS no permitido: ${origin}`);
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_LIMIT }));

// Servir archivos estáticos desde storage
app.use('/api/files', express.static(join(__dirname, 'storage')));

// Inicializar base de datos
initDatabase();

// ==================== RUTAS API ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Fleet Tracking Server is running' });
});

// ==================== MARCADORES ====================

// GET - Obtener todos los marcadores
app.get('/api/marcadores', (req, res) => {
  try {
    const marcadores = getAllMarcadores();
    res.json({ success: true, data: marcadores });
  } catch (error) {
    console.error('Error al obtener marcadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET - Obtener un marcador por ID
app.get('/api/marcadores/:id', (req, res) => {
  try {
    const marcador = getMarcadorById(req.params.id);
    if (!marcador) {
      return res.status(404).json({ success: false, error: 'Marcador no encontrado' });
    }
    res.json({ success: true, data: marcador });
  } catch (error) {
    console.error('Error al obtener marcador:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Función auxiliar para determinar la carpeta según el tipo MIME
function getFileFolder(mimetype) {
  if (mimetype?.startsWith('image/')) return 'imagenes';
  if (mimetype?.startsWith('video/')) return 'videos';
  return 'documentos';
}

// POST - Crear un nuevo marcador (con soporte para archivos)
app.post('/api/marcadores', upload.single('archivo'), (req, res) => {
  try {
    const { lat, lng, categoria, descripcion } = req.body;
    const archivo = req.file;

    // Validaciones
    if (!lat || !lng) {
      // Si se subió un archivo pero hay error, eliminarlo
      if (archivo) deleteFile(archivo.filename, getFileFolder(archivo.mimetype));
      return res.status(400).json({ success: false, error: 'Latitud y longitud son requeridas' });
    }
    if (!categoria || !['alerta', 'peligro', 'informacion'].includes(categoria)) {
      if (archivo) deleteFile(archivo.filename, getFileFolder(archivo.mimetype));
      return res.status(400).json({ success: false, error: 'Categoría inválida' });
    }
    if (!descripcion || descripcion.trim().length < 10) {
      if (archivo) deleteFile(archivo.filename, getFileFolder(archivo.mimetype));
      return res.status(400).json({ success: false, error: 'Descripción debe tener al menos 10 caracteres' });
    }

    // Procesar archivo si existe
    let archivoUrl = null;
    if (archivo) {
      const folder = getFileFolder(archivo.mimetype);
      archivoUrl = getFileUrl(archivo.filename, folder);
    }

    const marcador = createMarcador({
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      categoria,
      descripcion: descripcion.trim(),
      archivo: archivoUrl, // Guardar URL en lugar de Base64
      user_id: req.body.user_id || null, // Agregar user_id si está disponible
      timestamp: new Date().toISOString()
    });

    // Emitir evento Socket.IO para notificar a los clientes (excepto al creador)
    // Usar la función helper para emitir solo a otros usuarios
    const creatorUserId = req.body.user_id || null;
    if (creatorUserId) {
      console.log(`📤 Emitiendo marcador:creado a otros usuarios (excluyendo: ${creatorUserId})`);
      emitToOthers(creatorUserId, 'marcador:creado', marcador).catch(err => {
        console.error('Error al emitir marcador:creado:', err);
      });
    } else {
      // Si no hay userId, emitir a todos (compatibilidad hacia atrás)
      console.log('⚠️  Marcador creado sin userId, emitiendo a todos los clientes');
      io.emit('marcador:creado', marcador);
    }

    res.status(201).json({ success: true, data: marcador });
  } catch (error) {
    console.error('Error al crear marcador:', error);
    // Si hay error y se subió archivo, eliminarlo
    if (req.file) {
      deleteFile(req.file.filename, getFileFolder(req.file.mimetype));
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT - Actualizar un marcador (con soporte para archivos)
app.put('/api/marcadores/:id', upload.single('archivo'), (req, res) => {
  try {
    const { lat, lng, categoria, descripcion } = req.body;
    const archivo = req.file;
    const marcadorActual = getMarcadorById(req.params.id);

    // Validaciones
    if (!lat || !lng) {
      if (archivo) deleteFile(archivo.filename, getFileFolder(archivo.mimetype));
      return res.status(400).json({ success: false, error: 'Latitud y longitud son requeridas' });
    }
    if (categoria && !['alerta', 'peligro', 'informacion'].includes(categoria)) {
      if (archivo) deleteFile(archivo.filename, getFileFolder(archivo.mimetype));
      return res.status(400).json({ success: false, error: 'Categoría inválida' });
    }
    if (descripcion && descripcion.trim().length < 10) {
      if (archivo) deleteFile(archivo.filename, getFileFolder(archivo.mimetype));
      return res.status(400).json({ success: false, error: 'Descripción debe tener al menos 10 caracteres' });
    }

    // Si hay un nuevo archivo, eliminar el anterior
    let archivoUrl = marcadorActual?.archivo || null;
    if (archivo) {
      // Eliminar archivo anterior si existe
      if (marcadorActual?.archivo) {
        const urlParts = marcadorActual.archivo.split('/');
        const filename = urlParts[urlParts.length - 1];
        const folder = urlParts[urlParts.length - 2];
        deleteFile(filename, folder);
      }
      // Guardar nuevo archivo
      const folder = getFileFolder(archivo.mimetype);
      archivoUrl = getFileUrl(archivo.filename, folder);
    }

    const marcador = updateMarcador(req.params.id, {
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      categoria,
      descripcion: descripcion?.trim(),
      archivo: archivoUrl
    });

    if (!marcador) {
      if (archivo) deleteFile(archivo.filename, getFileFolder(archivo.mimetype));
      return res.status(404).json({ success: false, error: 'Marcador no encontrado' });
    }

    // Emitir evento Socket.IO (excepto al usuario que actualizó)
    emitToOthers(req.body.user_id, 'marcador:actualizado', marcador).catch(err => {
      console.error('Error al emitir marcador:actualizado:', err);
    });

    res.json({ success: true, data: marcador });
  } catch (error) {
    console.error('Error al actualizar marcador:', error);
    if (req.file) {
      deleteFile(req.file.filename, getFileFolder(req.file.mimetype));
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE - Eliminar un marcador (y su archivo asociado)
app.delete('/api/marcadores/:id', (req, res) => {
  try {
    const marcador = getMarcadorById(req.params.id);
    
    if (!marcador) {
      return res.status(404).json({ success: false, error: 'Marcador no encontrado' });
    }

    // Eliminar archivo asociado si existe
    if (marcador.archivo) {
      try {
        const urlParts = marcador.archivo.split('/');
        const filename = urlParts[urlParts.length - 1];
        const folder = urlParts[urlParts.length - 2];
        deleteFile(filename, folder);
      } catch (fileError) {
        console.warn('No se pudo eliminar el archivo:', fileError);
      }
    }

    // Obtener user_id antes de eliminar
    const marcadorUserId = marcador.user_id || null;

    const deleted = deleteMarcador(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Marcador no encontrado' });
    }

    // Emitir evento Socket.IO (excepto al usuario que eliminó)
    emitToOthers(marcadorUserId, 'marcador:eliminado', { id: req.params.id }).catch(err => {
      console.error('Error al emitir marcador:eliminado:', err);
    });

    res.json({ success: true, message: 'Marcador eliminado correctamente' });
  } catch (error) {
    console.error('Error al eliminar marcador:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET - Estadísticas de marcadores
app.get('/api/marcadores/stats/estadisticas', (req, res) => {
  try {
    const stats = getEstadisticasMarcadores();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== COORDENADAS GPS ====================

// POST - Guardar coordenada GPS
app.post('/api/coordenadas', (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({ success: false, error: 'Latitud y longitud son requeridas' });
    }

    const id = saveCoordenadaGPS({
      lat,
      lng,
      accuracy,
      timestamp: new Date().toISOString()
    });

    // Emitir evento Socket.IO para tracking en tiempo real
    // Nota: Este endpoint se mantiene por compatibilidad, pero el socket ya maneja esto
    io.emit('coordenada:nueva', { 
      id, 
      lat, 
      lng, 
      accuracy, 
      user_id: req.body.user_id || null,
      timestamp: new Date().toISOString() 
    });

    res.status(201).json({ success: true, data: { id, lat, lng, accuracy } });
  } catch (error) {
    console.error('Error al guardar coordenada:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET - Obtener últimas coordenadas GPS
app.get('/api/coordenadas', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const coordenadas = getUltimasCoordenadas(limit);
    res.json({ success: true, data: coordenadas });
  } catch (error) {
    console.error('Error al obtener coordenadas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET - Obtener coordenadas por rango de tiempo
app.get('/api/coordenadas/rango', (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    if (!fechaInicio || !fechaFin) {
      return res.status(400).json({ success: false, error: 'fechaInicio y fechaFin son requeridos' });
    }

    const coordenadas = getCoordenadasPorRango(fechaInicio, fechaFin);
    res.json({ success: true, data: coordenadas });
  } catch (error) {
    console.error('Error al obtener coordenadas por rango:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SOCKET.IO ====================

// Mapa para mantener la relación userId -> socketId
const userSocketMap = new Map();
// Mapa para rastrear si un usuario ya fue notificado como conectado en esta sesión
const usuariosNotificados = new Map();
// Mapa para mantener las últimas ubicaciones de cada usuario - DESHABILITADO (solo marcador local)
// const ultimasUbicaciones = new Map();

io.on('connection', (socket) => {
  console.log(`✅ Cliente conectado: ${socket.id}`);

  // Enviar todos los marcadores al cliente cuando se conecta
  socket.emit('marcadores:iniciales', getAllMarcadores());

  // ==================== REGISTRO DE USUARIO ====================
  socket.on('usuario-conectado', async (data) => {
    try {
      const { id, nombre, plataforma, modeloDispositivo } = data;
      
      if (!id) {
        console.warn('⚠️  Intento de conexión sin ID de usuario');
        return;
      }

      // Verificar si el usuario ya estaba conectado (reconexión)
      let yaEstabaConectado = false;
      const socketIdAnterior = userSocketMap.get(id);
      
      // Si hay un socket anterior, verificar si realmente está conectado
      if (socketIdAnterior) {
        try {
          const sockets = await io.fetchSockets();
          const socketAnteriorActivo = sockets.find(s => s.id === socketIdAnterior);
          yaEstabaConectado = !!socketAnteriorActivo;
          
          // Si el socket anterior no está activo, limpiar el mapa
          if (!socketAnteriorActivo) {
            userSocketMap.delete(id);
            usuariosNotificados.delete(id);
            yaEstabaConectado = false;
          }
        } catch (error) {
          console.warn('Error al verificar sockets activos:', error);
          // En caso de error, asumir que es una nueva conexión
          yaEstabaConectado = false;
        }
      }

      // Guardar userId en el socket para referencia posterior
      socket.userId = id;
      
      // Registrar o actualizar usuario en la base de datos (primero obtener los datos)
      const usuario = registrarOActualizarUsuario({
        id,
        nombre: nombre || null,
        plataforma: plataforma || 'web',
        modeloDispositivo: modeloDispositivo || null
      });
      
      // Guardar información del usuario en el socket para usar al desconectar
      socket.userInfo = {
        numUsuario: usuario.num_usuario || null,
        nombre: usuario.nombre || null,
        plataforma: usuario.plataforma || 'web'
      };
      
      // Actualizar el mapa de usuarios conectados con el nuevo socket
      userSocketMap.set(id, socket.id);

      if (yaEstabaConectado) {
        console.log(`🔄 Usuario reconectado: ${id} (${usuario.plataforma || 'web'}) - Número: ${usuario.num_usuario || 'N/A'}`);
      } else {
        console.log(`👤 Usuario ${usuario.actualizado ? 'actualizado' : 'registrado'}: ${id} (${usuario.plataforma || 'web'}) - Número: ${usuario.num_usuario || 'N/A'}`);
      }

      // Solo notificar a otros usuarios si es una nueva conexión (no reconexión)
      if (!yaEstabaConectado) {
        // Marcar como notificado
        usuariosNotificados.set(id, true);
        
        // Notificar a otros usuarios que alguien se conectó (excepto al mismo)
        socket.broadcast.emit('cliente-conectado', {
          userId: id,
          numUsuario: usuario.num_usuario || null,
          nombre: nombre || null,
          plataforma: plataforma || 'web',
          timestamp: new Date().toISOString()
        });
      }

      // Confirmar al usuario que se registró correctamente
      socket.emit('usuario-registrado', {
        success: true,
        userId: id,
        usuario: getUsuarioById(id)
      });

      // Envío de ubicaciones de usuarios conectados - DESHABILITADO (solo marcador local)
      // const ubicacionesValidas = [];
      // ultimasUbicaciones.forEach((ubicacion, userId) => {
      //   // Validar coordenadas antes de incluir
      //   if (ubicacion && 
      //       Number.isFinite(ubicacion.lat) && 
      //       Number.isFinite(ubicacion.lng) &&
      //       !(ubicacion.lat === 0 && ubicacion.lng === 0) &&
      //       ubicacion.lat >= -90 && ubicacion.lat <= 90 &&
      //       ubicacion.lng >= -180 && ubicacion.lng <= 180) {
      //     ubicacionesValidas.push({
      //       userId,
      //       lat: ubicacion.lat,
      //       lng: ubicacion.lng,
      //       speed: ubicacion.speed || 0,
      //       timestamp: ubicacion.timestamp || Date.now()
      //     });
      //   }
      // });
      // if (ubicacionesValidas.length > 0) {
      //   socket.emit('ubicaciones-usuarios-conectados', ubicacionesValidas);
      // }
    } catch (error) {
      console.error('❌ Error al registrar usuario:', error);
      socket.emit('usuario-registrado', {
        success: false,
        error: error.message
      });
    }
  });

  // ==================== ACTUALIZACIÓN DE UBICACIÓN ====================
  // EVENTO DESHABILITADO - Solo marcador local, sin tracking multiusuario
  /*
  socket.on('coordenada:actualizar', (data) => {
    try {
      const { lat, lng, accuracy, userId } = data;
      
      if (!lat || !lng) {
        console.warn('⚠️  Coordenada inválida recibida');
        return;
      }

      // Usar userId del socket si no viene en los datos
      const user_id = userId || socket.userId || null;

      // Guardar coordenada en la base de datos
      const id = saveCoordenadaGPS({
        user_id,
        lat,
        lng,
        accuracy,
        timestamp: new Date().toISOString()
      });
      
      // Obtener información del usuario para incluir en el evento
      let usuarioInfo = null;
      if (user_id) {
        try {
          usuarioInfo = getUsuarioById(user_id);
        } catch (error) {
          console.warn('Error al obtener información del usuario:', error);
        }
      }

      // Emitir a todos los clientes EXCEPTO al que envió (usando broadcast)
      socket.broadcast.emit('coordenada:nueva', {
        id,
        lat,
        lng,
        accuracy,
        user_id,
        numUsuario: usuarioInfo?.num_usuario || null,
        plataforma: usuarioInfo?.plataforma || null,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error al procesar coordenada:', error);
    }
  });

  // ==================== UBICACIÓN EN TIEMPO REAL ====================
  // EVENTO DESHABILITADO - Solo marcador local, sin tracking multiusuario
  /*
  socket.on('ubicacion-actual', (data) => {
    try {
      const { userId, lat, lng, speed, timestamp, accuracy } = data;

      // Validación estricta de coordenadas en el servidor
      if (lat === undefined || lng === undefined || lat === null || lng === null) {
        console.warn('⚠️  Ubicación inválida recibida: lat o lng faltantes');
        return;
      }

      // Validar que sean números finitos
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        console.warn('⚠️  Ubicación inválida recibida: lat o lng no son números finitos', { lat, lng });
        return;
      }

      // Rechazar coordenadas (0, 0) - punto nulo
      if (lat === 0 && lng === 0) {
        console.warn('⚠️  Ubicación inválida recibida: punto nulo (0, 0)');
        return;
      }

      // Validar rangos
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        console.warn('⚠️  Ubicación inválida recibida: coordenadas fuera de rango', { lat, lng });
        return;
      }

      // Validar accuracy si existe (descartar si > 200m)
      if (accuracy !== undefined && accuracy !== null && Number.isFinite(accuracy) && accuracy > 200) {
        console.warn('⚠️  Ubicación descartada: precisión GPS muy baja (>200m)', { lat, lng, accuracy });
        return;
      }

      // Usar userId del socket si no viene en los datos
      const user_id = userId || socket.userId || null;

      if (!user_id) {
        console.warn('⚠️  Ubicación recibida sin userId');
        return;
      }

      // Verificar si la posición cambió significativamente - DESHABILITADO (solo marcador local)
      // const lastLocation = ultimasUbicaciones.get(user_id);
      let shouldBroadcast = false; // Siempre false, no reenviar ubicaciones

      // Actualizar última ubicación - DESHABILITADO (solo marcador local)
      // ultimasUbicaciones.set(user_id, { ... });

      // Solo guardar en BD y reenviar si hay cambio significativo
      if (shouldBroadcast) {
        // Guardar coordenada en la base de datos (opcional, para historial)
        try {
          saveCoordenadaGPS({
            user_id,
            lat,
            lng,
            accuracy: (accuracy !== undefined && accuracy !== null && Number.isFinite(accuracy)) ? accuracy : null,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          console.warn('Error al guardar coordenada en BD:', error);
        }

        // Reenviar ubicación a todos EXCEPTO al cliente emisor
        socket.broadcast.emit('ubicacion-usuario', {
          userId: user_id,
          lat,
          lng,
          speed: speed || 0,
          accuracy: (accuracy !== undefined && accuracy !== null && Number.isFinite(accuracy)) ? accuracy : undefined,
          timestamp: timestamp || Date.now()
        });

        // Solo loggear cuando realmente se reenvía (no cada 300ms)
        console.log(`📍 Ubicación recibida de usuario ${user_id} y reenviada a otros clientes`);
      }
    } catch (error) {
      console.error('❌ Error al procesar ubicación:', error);
    }
  });

  socket.on('disconnect', async () => {
    const userId = socket.userId || null;
    
    if (userId) {
      // Limpiar ubicación del usuario desconectado - DESHABILITADO (solo marcador local)
      // ultimasUbicaciones.delete(userId);
      
      // Verificar si el usuario tiene otro socket activo (reconexión rápida)
      const socketActual = userSocketMap.get(userId);
      
      // Solo procesar desconexión si este es el socket actual del usuario
      if (socketActual === socket.id) {
        // Remover del mapa de usuarios conectados
        userSocketMap.delete(userId);
        // Remover de usuarios notificados para permitir notificación en próxima conexión
        usuariosNotificados.delete(userId);
        
        // Usar la información del usuario guardada en el socket (no consultar BD)
        const userInfo = socket.userInfo || {};
        if (userInfo.numUsuario || userInfo.plataforma) {
          // Notificar a otros usuarios que alguien se desconectó
          socket.broadcast.emit('cliente-desconectado', {
            userId: userId,
            numUsuario: userInfo.numUsuario || null,
            nombre: userInfo.nombre || null,
            plataforma: userInfo.plataforma || 'web',
            timestamp: new Date().toISOString()
          });
          console.log(`❌ Usuario desconectado: ${userId} (${userInfo.plataforma || 'web'}) - Número: ${userInfo.numUsuario || 'N/A'}`);
        }
      } else {
        console.log(`🔄 Socket antiguo eliminado: ${socket.id} (Usuario: ${userId} ya tiene nuevo socket)`);
      }
    } else {
      console.log(`❌ Cliente desconectado: ${socket.id} (Usuario desconocido)`);
    }
  });
});

/**
 * Función helper para emitir eventos a todos excepto al usuario especificado
 */
async function emitToOthers(userId, event, data) {
  if (!userId) {
    // Si no hay userId, emitir a todos (compatibilidad hacia atrás)
    io.emit(event, data);
    return;
  }

  // Obtener todos los sockets conectados
  const sockets = await io.fetchSockets();
  sockets.forEach(socket => {
    if (socket.userId !== userId) {
      socket.emit(event, data);
    }
  });
}

// Middleware para manejar errores de payload demasiado grande (debe ir después de todas las rutas)
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large' || err.status === 413 || err.message?.includes('too large') || err.name === 'PayloadTooLargeError') {
    return res.status(413).json({
      success: false,
      error: `Payload demasiado grande. Límite actual: ${JSON_LIMIT}. El archivo debe ser más pequeño.`,
      limit: JSON_LIMIT
    });
  }
  // Pasar otros errores al siguiente middleware
  next(err);
});

// Manejo de errores del proceso
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  closeDatabase();
  httpServer.close(() => {
    console.log('✅ Servidor cerrado correctamente');
    process.exit(0);
  });
});

// Iniciar servidor
httpServer.listen(PORT, () => {
  console.log(`🚀 Servidor Fleet Tracking iniciado en puerto ${PORT}`);
  console.log(`📡 Socket.IO disponible en http://localhost:${PORT}`);
  console.log(`🌐 API REST disponible en http://localhost:${PORT}/api`);
  console.log(`📦 Límite de JSON: ${JSON_LIMIT}`);
  console.log(`🌍 Orígenes CORS permitidos: ${CORS_ORIGINS.join(', ')}`);
});


