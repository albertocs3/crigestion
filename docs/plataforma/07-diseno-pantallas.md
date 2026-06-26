# Diseno de pantallas de Plataforma

## 1. Proposito

Define la experiencia web inicial de Plataforma para CriGestión con Next.js.

## 2. Pantallas iniciales

| Ruta | Pantalla | Proposito |
|---|---|---|
| `/` | Inicio operativo | Mostrar estado general y acceso a inicializacion |
| `/platform/installation` | Estado de instalacion | Mostrar si la plataforma esta inicializada |

## 3. Inicio operativo

Contenido:

- Marca `CriGestión`.
- Estado de instalacion.
- Acceso a `/platform/installation`.

Estados:

- Pendiente de inicializacion.
- Inicializado.
- Error de conexion a base de datos, gestionado por error boundary futuro.

## 4. Estado de instalacion

Contenido cuando no existe instalacion:

- Mensaje de instalacion pendiente.
- Accion futura para abrir formulario de inicializacion.

Contenido cuando existe instalacion:

- Estado.
- Empresa.
- Administrador inicial.

## 5. Formulario pendiente

La siguiente iteracion debe crear un Client Component para:

- Datos de empresa.
- Datos de administrador.
- Validacion local orientativa.
- Envio a `POST /api/platform/installation/initialize`.
- Estados de carga, exito y error.

## 6. Criterios UI

- Server Components por defecto.
- Client Components solo para formularios.
- Textos claros y compactos.
- Nada de secretos en pantalla de resumen.
- Estados vacio, carga y error visibles.
