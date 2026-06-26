# ADR-0017: Gestionar copias completas y restauración en modo controlado

## Estado

Aceptada.

## Contexto

CriGestión almacenará base de datos, adjuntos, claves, configuración y documentos emitidos. La pérdida o restauración parcial puede romper integridad funcional, fiscal o de auditoría.

## Decisión

Las copias serán completas e incluirán:

- Base de datos.
- Repositorio de adjuntos.
- Configuración necesaria.
- Anillo de claves protegido.

La restauración se realizará en modo mantenimiento exclusivo, mediante herramienta o procedimiento controlado.

## Alternativas consideradas

- Copiar solo base de datos: insuficiente por adjuntos y claves.
- Copiar carpetas sin coordinación con SQL: puede generar inconsistencias.
- Restauración desde la aplicación normal: arriesga concurrencia y sesiones activas.

## Consecuencias

- Las copias deben tener manifiesto, hash y cifrado.
- La restauración invalidará sesiones.
- Debe quedar evidencia de restauración fuera del contenido restaurado.
- La estrategia deberá probarse, no solo documentarse.
