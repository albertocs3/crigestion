# Contrato VeriFactu V1

## 1. Proposito y vigencia

Este documento define el contrato interno estable previo al adaptador AEAT. No
es una copia del XSD oficial ni autoriza por si solo una puesta en produccion.

Base comprobada a 2026-07-13:

- [RD 1007/2023 consolidado](https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840).
- [Orden HAC/1177/2024](https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138).
- [RDL 15/2025 y plazos de adaptacion](https://www.boe.es/buscar/doc.php?id=BOE-A-2025-24446).
- [Portal tecnico AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/informacion-tecnica.html).
- [FAQ oficial AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes.html).

Plazos vigentes: 1 de enero de 2027 para los obligados del articulo 3.1.a y 1
de julio de 2027 para el resto del articulo 3.1. Se verificaran de nuevo antes
de produccion; existe litigio constitucional admitido sobre la modificacion,
sin suspension indicada del texto vigente.

## 2. Alcance V1

- Modalidad unica `VERIFACTU`.
- Registros `ALTA` y `ANULACION`.
- Facturas ordinarias, simplificadas y rectificativas que soporte Facturacion.
- Cadena independiente por `companyId` e instalacion SIF.
- Preparacion determinista, remision por lotes, reintento y conciliacion.
- QR real y leyenda VERI*FACTU cuando proceda.

Quedan fuera: modo no verificable, firma XAdES de registros y migracion desde
otro SIF sin un procedimiento de cadena aprobado.

## 3. Invariantes normativas

1. El alta se genera automaticamente de forma simultanea o inmediatamente anterior a expedir la factura.
2. Alta y anulacion son inmutables y se agregan a la cadena; nunca se sobrescriben ni eliminan para corregirlos.
3. Cada registro referencia al cronologicamente anterior mediante los campos oficiales y su huella.
4. La marca temporal incluye huso horario y el reloj debe mantenerse dentro del margen oficial de un minuto.
5. La huella usa el algoritmo y canonicalizacion publicados por AEAT; actualmente SHA-256, sujeto al manifiesto tecnico fijado para la release.
6. Los importes del registro se expresan en euros conforme al esquema oficial.
7. La rectificativa fiscal ordinaria genera su propio alta. `ANULACION` se reserva para anular un alta emitida erroneamente.
8. La remision es consecutiva y ordenada; una indisponibilidad no permite saltar registros de la misma cadena.
9. Los registros, respuestas y exportaciones se conservan de forma legible, trazable e integra durante el plazo legal aplicable.
10. Toda factura expedida por el SIF incorpora QR; en factura electronica estructurada se incorpora la URL como campo independiente cuando la norma lo permita.

## 4. Tipos internos

El adaptador expondra tipos discriminados equivalentes a:

```text
VerifactuContractVersion = "VF_V1"
Environment = "TEST" | "PRODUCTION"
RecordType = "ALTA" | "ANULACION"
DeliveryState =
  "PREPARED" | "QUEUED" | "SUBMITTING" | "ACCEPTED" |
  "ACCEPTED_WITH_ERRORS" | "REJECTED" | "CANCELLED" |
  "RETRYABLE_FAILURE" | "UNKNOWN"
```

`PreparedRecordV1` incluye:

- `recordId`, `invoiceId`, `companyId`, `sifInstallationId` y versiones de contrato/esquema.
- Tipo de registro y clave fiscal de factura: NIF emisor, serie, numero y fecha.
- Snapshot de emisor, destinatario, desglose fiscal, cuotas e importes.
- Tipo de factura, circunstancias fiscales y referencias exigidas por el esquema.
- Identidad de productor, sistema, version e instalacion.
- Marca temporal con huso.
- Identidad y huella del registro anterior, algoritmo, version de canonicalizacion y huella propia.
- XML UTF-8 preparado, su hash de contenido y datos necesarios para QR.

No contiene certificado, clave privada ni contrasena.

## 5. Puerto del adaptador

```text
prepare(input, previousRecord) -> PreparedRecordV1
submit(batch, credentialRef, idempotencyKey) -> SubmissionResultV1
reconcile(unknownSubmission) -> SubmissionResultV1
```

`prepare` es puro y determinista para los mismos snapshots, versiones y
registro anterior. `submit` aplica autenticacion server-side y respeta el
maximo oficial de registros, el tiempo de espera devuelto y el orden de cadena.

La emision dispone del puerto puro e inyectable y comparte la transaccion de
factura con la persistencia fiscal. Activar VeriFactu sin instalacion o
preparador produce un fallo cerrado y revierte completamente la emision.

El primer corte del adaptador normativo implementa dos primitivas verificadas:

- Huella `ALTA` segun especificacion AEAT 0.1.2: ocho campos en orden oficial,
  UTF-8, SHA-256 y hexadecimal mayusculo. Los tests reproducen los dos vectores
  oficiales de primer registro y registro encadenado.
- URL QR VERI*FACTU segun especificacion AEAT 0.5.0: hosts separados de pruebas
  y produccion, cuatro parametros obligatorios en orden y percent-encoding por
  componente.

El XML `RegistroAlta`, su validacion XSD/semantica y el cifrado autenticado del
payload forman parte del preparador conectado a `issueInvoice`.

El constructor XML cubre ya un subconjunto deliberadamente cerrado: factura
ordinaria `F1` y rectificativa por diferencias `R4/I`, destinatario nacional
con NIF, IVA sujeto `S1`/`S2`, regimenes del catalogo XSD y primer registro o
registro anterior. La rectificativa referencia el ALTA original aceptado desde
su snapshot fiscal inmutable. Genera
`RegFactuSistemaFacturacion` con los namespaces y el orden del esquema
`tikeV1.0`, escapa XML 1.0 y verifica fechas, limites, totales, identidad de la
cadena y correspondencia de la huella antes de serializar.

Siguen fuera del constructor: `IDOtro`, exentas/no sujetas `N1`/`N2` y `E1` a
`E8`, simplificadas, rectificativas `R1`/`R2`/`R3`/`R5`, rectificativas por
sustitucion, terceros, recargo, cupon y macrodato. El motivo `UNPAID` no se
infiere automaticamente como `R3` y queda fuera de este primer corte. No se
considerara activable hasta validar fixtures contra los XSD locales fijados y
las reglas semanticas del documento de validaciones AEAT, sin resolucion de
entidades o esquemas remotos durante la validacion.

La validacion XSD offline se ejecuta con `npm run verifactu:validate-xsd` y
`npm run verifactu:validate-r4-xsd`. El
comando verifica y materializa en `tmp/` los esquemas de suministro, tipos
comunes y XMLDSig contra el manifiesto, y despues valida con red, DTD y entidades
externas deshabilitadas. Requiere instalar previamente
`requirements-verifactu.txt`. Incluye un golden `F1` valido y un fixture con
orden incorrecto que debe ser rechazado, ademas de un golden encadenado de
`RegistroAnulacion`.

La anulacion V1 genera un nuevo eslabon inmutable y conserva el ALTA original.
Solo es elegible un ALTA de la misma empresa e instalacion activa cuyo ultimo
resultado sea `ACCEPTED` o `ACCEPTED_WITH_ERRORS`, con toda su cola procesada y
sin anulacion previa. La identidad fiscal se copia del snapshot del ALTA, no de
campos actuales editables. La huella reproduce el vector oficial 0.1.2 y el XML
se valida offline contra `SuministroLR.xsd`.

La preparacion y persistencia de la anulacion bloquean la cabecera SIF, aplican
CAS sobre el ultimo registro, insertan registro, outbox y auditoria en una sola
transaccion y nunca llaman a AEAT dentro de ella. El transporte exige que la
respuesta inmediata declare `Operacion=Anulacion`; una entrega incierta pasa a
consulta y solo `EstadoRegistro=Anulado` confirma el efecto. Al aceptarse, la
proyeccion de factura pasa a `CANCELLED`, sin alterar su estado comercial o
contable.

La regularizacion comercial y contable es un paso separado y explicito. Solo
para una factura emitida por error, sin cobros, devoluciones ni remesas, el
permiso `Billing.FinalizeVerifactuCancellation` permite pasarla a `VOIDED`,
cancelar sus vencimientos pendientes y contabilizar un asiento inverso
append-only enlazado al original. No se borra ni reescribe ninguna evidencia
fiscal o contable. Las rectificaciones por diferencia de facturas integradas
en VeriFactu generan un ALTA `R4` incremental (`TipoRectificativa=I`) que
referencia la factura original en `FacturasRectificadas`. La factura, el
asiento, el registro fiscal y su outbox se confirman de forma atomica; si la
preparacion fiscal falla, no se crea la rectificativa.

El corte R4 actual solo permite la rectificacion integra de facturas sin
actividad financiera: todos los vencimientos deben seguir pendientes y no
puede haber cobros, devoluciones ni lineas de remesa activas. La rectificativa
se registra con estado de cobro `NOT_APPLICABLE` y sin vencimientos, porque un
abono no es un derecho de cobro negativo. En la misma transaccion, los
vencimientos de la factura original pasan a `CANCELLED` y su estado de cobro a
`CANCELLED`. Las facturas con actividad financiera fallan con
`INVOICE_RECTIFICATION_FINANCIAL_ACTIVITY` hasta disponer de un modelo
explicito de credito, compensacion y reembolso al cliente.

Este corte mantiene fuera de alcance `SinRegistroPrevio` y las anulaciones
sucesoras de una anulacion rechazada. Si AEAT rechaza un ALTA original, el panel
operativo puede generar un nuevo ALTA por rechazo con el mismo `IDFactura`,
`Subsanacion=S` y `RechazoPrevio=X`. El nuevo registro enlaza al rechazado,
conserva ambos payloads e intentos de forma inmutable y solo se permite cuando
el operador confirma que no procede una factura rectificativa.

El preparador `F1` ya compone huella, QR, XML y cifrado autenticado. El payload
usa un sobre binario versionado `CGVF` con AES-256-GCM, nonce aleatorio de 96
bits, tag de 128 bits, algoritmo e identificador de clave en la cabecera. La
cabecera y el contexto de empresa, instalacion, factura, clave de preparacion,
hash del XML, entorno y tipo de registro se autentican como AAD.

Las claves se proporcionan exclusivamente mediante un keyring server-side:
`VERIFACTU_PAYLOAD_ACTIVE_KEY_ID` selecciona la clave de cifrado y
`VERIFACTU_PAYLOAD_KEYS` contiene un objeto JSON de claves base64 de 32 bytes.
Las claves historicas deben conservarse mientras existan payloads cifrados con
ellas; retirarlas requiere recifrado controlado o fin probado de la retencion.
No se reutilizan secretos de sesion, backup ni certificados.

La ruta de emision carga el preparador configurado solo cuando
`VERIFACTU_ENABLED=true`. Una configuracion ausente/invalida o un documento fuera
del subconjunto `F1` falla cerrada y revierte la emision completa.

El subconjunto activable actual acepta exclusivamente codigos `IVA_4`, `IVA_10`
e `IVA_21`, bases y cuotas positivas, regimen `01` y calificacion `S1`. Un IVA
cero, exencion, no sujecion, inversion, recargo, codigo personalizado o importe
negativo se rechaza antes de generar XML. El preparador exige ademas contrato
`VF_V1`, esquema `tikeV1.0` y coincidencia exacta de version y SHA-256 del
manifiesto fijado. La clave de preparacion depende de la idempotencia, factura,
manifiesto y tipo de registro, no del reloj ni del nonce de cifrado.

El worker de outbox usa claim corto con `FOR UPDATE SKIP LOCKED`, lease owner y
token UUID. Descifra y llama al puerto de transporte fuera de la transaccion;
despues confirma intento terminal append-only, estado del mensaje, proyeccion de
factura y auditoria en una segunda transaccion protegida por CAS del lease.
Comprueba antes del envio el hash del outbox, el AAD y el SHA-256 del XML
descifrado.

La remision respeta el orden de cadena: una posicion posterior solo es elegible
cuando todas las anteriores tienen un intento `ACCEPTED` o
`ACCEPTED_WITH_ERRORS`. `UNKNOWN` en `SUBMIT` crea un mensaje `RECONCILE`; un
lease de envio vencido tambien se registra como `UNKNOWN` y pasa a conciliacion,
nunca a reenvio ciego. Rechazos, mensajes `DEAD` y conciliaciones no resueltas
bloquean posiciones posteriores para intervencion operativa.

El puerto de transporte recibe el entorno como union cerrada `TEST | PRODUCTION`
y no acepta una URL aportada por la credencial. `submit` recibe el XML y un ID
interno de peticion; `reconcile` recibe la clave fiscal estructurada (nombre y
NIF del emisor, numero y fecha), porque debe construir `ConsultaFactuSistemaFacturacion` y nunca
reenviar el alta para averiguar si un timeout produjo efectos.

Los fallos locales de integridad del payload y la ausencia de credencial pasan
directamente a `DEAD` con codigo estable y sin invocar el transporte. No se
confunden con indisponibilidad de AEAT ni se reintentan veinte veces. Un adaptador
concreto debera distinguir ademas fallo de red inequívocamente anterior al envio
(`RETRYABLE_FAILURE`) de timeout o corte tras una posible escritura (`UNKNOWN`).

La infraestructura implementa tres limites server-only conectados al worker:

- `CredentialProvider` resuelve una referencia opaca mediante un origen seguro
  inyectado, valida estado, prueba, vigencia, entorno y material PFX, y entrega
  una copia efimera que se borra al liberar el lease. La prueba queda ligada al
  SHA-256 del PFX y el origen debe liberar su copia al resolverla. El origen seguro y el
  cifrado persistente del PFX se resuelve mediante credenciales y versiones
  append-only con sobre AES-256-GCM y keyring externo.
- El cliente mTLS usa exclusivamente los cuatro endpoints VERI*FACTU fijados por
  el WSDL (normal/sello y pruebas/produccion), confianza del sistema, hostname,
  TLS 1.2 o superior, sin redireccion ni agente global, y limites de tiempo y
  cuerpo. Solo escribe despues de completar el handshake, para distinguir fallo
  previo de resultado posiblemente enviado.
- El codec SOAP 1.1 document/literal usa un parser SAX con namespaces, limites de
  bytes, profundidad, nodos y texto; rechaza DTD, entidades declaradas, CDATA,
  instrucciones de proceso, campos duplicados, orden o enumeraciones ajenas al
  contrato. Codifica consulta y decodifica tanto suministro como conciliacion;
  sus constantes se contrastan en tests con los hashes WSDL/XSD fijados.

El nombre del emisor queda congelado junto al NIF en el registro fiscal y la
respuesta se acepta solo si su clave fiscal coincide. Cada respuesta se cifra
con un keyring separado y AAD de empresa, instalacion, factura, preparacion,
operacion y peticion. Los eventos `VERIFACTU_MTLS_USE_STARTED` y
`VERIFACTU_MTLS_USE_COMPLETED` conservan trazabilidad sin PFX, password ni XML.
La prueba contra el portal AEAT es opt-in, solo TEST, mediante
`npm run verifactu:probe-aeat-test`; requiere credencial autorizada,
`VERIFACTU_AEAT_PROBE_ENABLED=true` y el registro exacto en
`VERIFACTU_AEAT_PROBE_RECORD_ID`. La consulta solo admite instalaciones TEST
activas de la misma empresa y deja auditoria de inicio y resultado.

El ciclo administrativo queda cerrado mediante
`POST /api/platform/verifactu/credentials`, que deriva la vigencia del PFX y
crea una version `STAGED` cifrada. Esta ruta acepta exclusivamente
`multipart/form-data`, con un unico PFX binario de hasta 512 KiB, campos
conocidos no repetidos y lectura acotada aun sin `Content-Length`; no transporta
el certificado como JSON/Base64. El hash de idempotencia es semantico e incluye
metadatos normalizados y el contenido mediante HMAC, por lo que no depende del
`boundary` multipart ni deja un verificador de password en persistencia. El
sistema usa `VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET`, separado del secreto de
sesiones y estable durante toda la retencion de registros idempotentes. El
sobre nuevo usa un framing binario versionado antes del cifrado y conserva
lectura compatible con el JSON cifrado legado. La activacion se realiza mediante
`POST /api/platform/verifactu/credential-versions/{versionId}/activate`, que
ejecuta `ConsultaLR` en AEAT TEST con esa version exacta. Solo una respuesta
SOAP fijada permite retirar la version anterior, activar la nueva y actualizar
la instalacion en una unica transaccion. Si se indica
`targetProductionSifInstallationId`, la misma transaccion puede asociarla a una
instalacion PRODUCTION activa de la empresa, siempre que la version lo autorice.

Ambas rutas requieren `Billing.ManageVerifactuCredentials`, origen permitido,
sesion, CSRF, `Idempotency-Key`, mantenimiento inactivo, limite de cuerpo y
rate limit. La auditoria nunca conserva PFX, password, ciphertext, XML o
respuesta en claro.

El panel `/app/verifactu/operations` usa permisos separados de lectura e
intervencion. Muestra cola, intentos seguros y caducidades a 30/7 dias sin
exponer XML, hashes, ciphertext, referencias mTLS ni identificadores externos.
La consulta devuelve como maximo los 100 mensajes mas recientes y avisa al
operador para que acote los filtros cuando existen mas resultados.
Una intervencion `DEAD` nunca llama a AEAT desde HTTP: concede trabajo al
worker. Solo reintenta `SUBMIT` si un fallo de credencial demuestra que no hubo
envio; cualquier fallo ambiguo se transforma en `RECONCILE`. Los fallos de
integridad y resultados terminales no son reintentables.
Las intervenciones aceptadas y los excesos de rate limit quedan auditados sin
material criptografico ni datos del certificado.

La identidad SIF TEST se crea en `/app/verifactu/installations` antes de
importar certificados. `POST /api/platform/verifactu/sif-installations` exige
`Billing.ManageVerifactuInstallations`, origen permitido, sesion, CSRF,
`Idempotency-Key`, mantenimiento inactivo, JSON acotado, rate limit y auditoria.
El servidor fija `TEST`, `ACTIVE`, `VF_V1`, `tikeV1.0` y el manifiesto AEAT
soportado; el cliente no puede aportar entorno, estado, cabeza de cadena,
credencial ni versiones tecnicas. Solo puede existir una instalacion activa por
empresa y entorno, y nunca se reemplaza implicitamente una cadena existente.

## 6. Persistencia requerida

La persistencia implementada separa:

- `verifactu_fiscal_records`: registros ALTA/ANULACION inmutables y encadenados.
- `verifactu_submission_attempts`: intentos append-only con request/response, tiempos y resultado estable.
- `verifactu_mtls_credentials` y sus versiones: referencia logica, rotacion,
  material cifrado y version exacta usada por cada intento.
- `verifactu_mtls_credential_test_attempts`: evidencia append-only de la prueba
  TEST y del hash exacto que fue probado.
- Outbox: claim, lease, intentos, `nextAttemptAt` y clave idempotente.
- `verifactu_worker_runs`: heartbeat, entorno, estado y contadores operativos
  por ejecucion, sin XML, certificado, NIF ni secretos.
- Proyeccion operativa en factura derivada del ultimo registro aplicable, su
  outbox y ultimo intento, separada del resultado fiscal AEAT.
- Manifiesto de version normativa, productor, SIF e instalacion.

La unicidad minima se aplica por cadena y posicion, un `ALTA` original por
factura e instalacion, un unico sucesor por cada rechazo subsanado y clave
idempotente de envio. PostgreSQL refuerza la pertenencia del target correctivo a
la misma empresa, factura e instalacion, y valida la continuidad de posicion y
huella.

## 7. Idempotencia y errores

- La clave de preparacion identifica registro, contrato y version normativa.
- Mismo cuerpo y clave reproduce resultado; misma clave con cuerpo distinto es conflicto.
- Tras timeout se marca `UNKNOWN` y se intenta conciliar antes de repetir.
- Un `SUBMIT` ambiguo queda definitivamente `PROCESSED`; crea o reactiva un
  `RECONCILE` seguro y nunca vuelve a abrir el envio original. La expiracion de
  su lease aplica la misma regla.
- Los errores AEAT se conservan sin convertir textos externos en contrato publico.
- Un resultado terminal `REJECTED` cierra ese intento y permite que el worker
  continue con la siguiente posicion ya generada; `UNKNOWN` y fallos sin
  resultado terminal siguen bloqueando el avance hasta conciliacion. La
  subsanacion se anade al final de la cadena y nunca reabre el SUBMIT rechazado.
- El dominio usa codigos internos estables y clasifica rechazo definitivo, fallo reintentable y resultado indeterminado.
- Una aceptacion parcial se resuelve por registro, aunque el transporte sea por lote.

## 8. QR, leyenda y PDF

El QR cumple ISO/IEC 18004, correccion M y tamano entre 30 y 40 mm. Su URL
incluye los campos oficiales de emisor, factura, fecha e importe y se construye
con la especificacion AEAT fijada para el entorno.

El PDF selecciona la URL inmutable del ultimo ALTA aplicable por posicion de
cadena y genera localmente un QR real con correccion M, zona silenciosa y 35 mm
de tamano. Solo admite los hosts AEAT fijados para TEST y PRODUCCION; no usa
servicios externos ni recalcula la URL desde el entorno de ejecucion. Las
facturas fuera de VeriFactu no muestran QR y, si VeriFactu aplica pero falta una
URL fiscal valida, la generacion del PDF falla de forma cerrada. En modalidad
VERI*FACTU incluye la leyenda oficial.

## 9. Seguridad y auditoria

- Certificado y clave de transporte cifrados server-side y referenciados por ID logico.
- Permisos de activacion, envio, reintento y consulta validados en servidor.
- Auditoria de preparacion, envio, respuesta, reconciliacion, anulacion y uso de credencial.
- No registrar claves, certificados, XML completos, NIF completo ni respuestas con datos fiscales en logs generales.
- Acceso a payloads fiscales restringido y auditado; backups y restauracion preservan cadena y manifiestos.

## 10. Criterios de entrada a implementacion

Antes de modificar persistencia o implementar transporte:

1. Descargar y fijar WSDL, XSD, validaciones, errores, algoritmo hash y QR desde AEAT.
2. Registrar URL, fecha, version y SHA-256 de cada artefacto en un manifiesto versionado.
3. Validar fixtures ALTA, ANULACION, rectificativa, encadenamiento y errores contra el portal de pruebas.
4. Confirmar sujeto remitente, representacion y certificado de transporte.
5. Aprobar modelo de retencion, acceso y exportacion.
6. Preparar declaracion responsable de la version del producto.
7. Ejecutar revision fiscal externa antes de activar produccion.

El primer inventario reproducible esta en
[`verifactu/aeat-artifacts.v1.json`](verifactu/aeat-artifacts.v1.json). Se
comprueba con `npm run verifactu:verify-manifest`; cualquier cambio de hash o
tamano bloquea la verificacion y exige revision antes de actualizar el
manifiesto.

## 11. Matriz minima de pruebas

- Primer registro y encadenamiento posterior de alta/anulacion.
- Dos emisiones concurrentes para la misma cadena sin bifurcacion.
- Reloj fuera de tolerancia y alarma operativa.
- Determinismo de XML, hash y QR con fixtures fijados.
- Lote aceptado, parcial, rechazado, timeout y reconciliacion.
- Reintento ordenado sin duplicar efectos.
- ALTA por rechazo `S/X`, target inmutable, idempotencia y continuidad de la
  cola cuando existen posiciones posteriores ya generadas.
- Certificado ausente, caducado, revocado o no autorizado.
- Restore que conserva posicion, hashes, Outbox e intentos.
- Ausencia de secretos y datos fiscales completos en logs y auditoria general.

## 12. Worker operativo

`npm run verifactu:worker` ejecuta un bucle secuencial con heartbeat persistente,
polling acotado, backoff de error y parada segura en `SIGINT`/`SIGTERM`.
`npm run verifactu:worker:once` realiza un unico ciclo para diagnostico.

El entorno es obligatorio mediante `VERIFACTU_WORKER_ENVIRONMENT` y se comprueba
contra `VERIFACTU_ENVIRONMENT`. El claim, la recuperacion de leases y la
finalizacion filtran por empresa y entorno en PostgreSQL. PRODUCCION requiere
ademas `VERIFACTU_WORKER_ALLOW_PRODUCTION=true`; el valor por defecto es falso.
El worker no reclama ni recupera mensajes durante mantenimiento de plataforma.

El panel autenticado `/app/verifactu/operations` muestra el ultimo heartbeat y
los contadores por entorno, y alerta si hay mensajes listos sin un worker
reciente o si el ultimo proceso termino con error. El endpoint publico de salud
no publica estos detalles.

En el entorno local Windows, `npm run verifactu:service:install` registra la
tarea supervisada `CriGestion-VeriFactu-TEST` para el usuario actual. La tarea
arranca al iniciar sesion, impide instancias simultaneas y usa un watchdog cada
minuto para recuperar el proceso tras un fallo. Al instalar, se genera el fichero
ignorado `.env.worker.local` mediante allowlist: toma la conexion de
`.env.test.local`, fija los flags TEST y copia unicamente los keyrings cifrados
necesarios desde `.env.local`, con ACL restringida. La instalacion se niega salvo
que el resultado fije `APP_ENV=test`, transporte y worker en TEST, base local
`crigestion_test` y PRODUCCION deshabilitada. `verifactu:service:status` muestra
solo metadatos de ejecucion y `verifactu:service:uninstall` la detiene y elimina.
Los secretos permanecen exclusivamente en el fichero de entorno y nunca se
copian a los argumentos del Programador de tareas. La accion ejecuta
`node.exe` directamente para que detener la tarea termine tambien el worker y
no deje procesos hijos huerfanos.

La tarea usa el comando interno `verifactu:worker:test`, que vuelve a exigir
TEST, `VERIFACTU_ENABLED=true` y `APP_ENV` distinto de `production` en cada
arranque. Tres fallos consecutivos del heartbeat hacen terminar el proceso con
error para que el supervisor lo reinicie. Las pruebas de persistencia se niegan
a truncar datos salvo con `APP_ENV=test`, confirmacion destructiva explicita y
la identidad exacta `crigestion_ci@crigestion_ci_test`. Vitest verifica tambien
la base y el usuario efectivos antes de cargar las suites; CI usa la misma
guarda antes de migrar. La base operativa `crigestion_test`, que conserva la
credencial y la evidencia de AEAT TEST, nunca se considera desechable.
El entorno local se copia desde `.env.vitest.example` a `.env.vitest.local`,
que esta ignorado, y las migraciones se aplican con
`npm run test:db:prepare`; no se ejecuta el seed global.

En Windows, una actualizacion que ejecute `prisma generate`, `npm install` o
reemplace el motor Prisma debe detener antes la tarea y arrancarla de nuevo al
terminar, porque el proceso mantiene cargada la DLL nativa. Esta pausa se hace
con la cola drenada o bajo mantenimiento y se confirma despues mediante el
heartbeat del panel.

Una rectificativa total de una factura completamente cobrada crea, en la misma
transaccion, un credito de cliente por el valor absoluto del documento. El
credito no es utilizable hasta que el estado fiscal de la rectificativa sea
`ACCEPTED`, `ACCEPTED_WITH_ERRORS` o `NOT_APPLICABLE`; un rechazo o estado
incierto conserva el saldo retenido y no genera salidas de dinero.

El despliegue reproducible usa `Dockerfile.worker` y el perfil Compose opt-in
`verifactu-test`. La imagen se construye con Node 22, genera Prisma durante el
build, ejecuta como usuario no root, no contiene ficheros `.env` y no publica
puertos. El servicio fija TEST, usa filesystem de solo lectura, `init`,
`SIGTERM`, 60 segundos de gracia y reinicio `unless-stopped`.

Antes de arrancarlo se crea `.env.worker.local` desde
`.env.worker.example`, con `DATABASE_URL` apuntando a `postgres:5432` y las
keyrings reales solo en el host. Las migraciones se aplican como fase separada
mediante el servicio one-shot `verifactu-migrate-test`, que debe terminar
correctamente antes de que Compose arranque el worker; el contenedor runtime no
migra la base. El migrador recibe una URL de base separada, no recibe keyrings y
se niega a actuar si el nombre confirmado no termina en `_test`. Un advisory
lock de PostgreSQL por empresa y entorno, retenido y monitorizado en una
conexion dedicada, impide que la tarea Windows y el contenedor procesen
simultaneamente, aunque la operacion normal sigue siendo detener un supervisor
antes de activar el otro.

`npm run verifactu:health` devuelve codigo cero y el texto estable
`VERIFACTU_WORKER_HEALTHY` solo si la ejecucion exacta publicada por el proceso
supervisado esta `RUNNING` y tanto su heartbeat como su ultimo ciclo de polling
tienen menos de 180 segundos, por encima de los timeouts HTTP maximos. Compose
usa la misma comprobacion como
`healthcheck`; un monitor externo puede alertar ante cualquier salida distinta
de cero sin acceder a certificados, XML ni datos fiscales. La identidad exacta
incluye `VERIFACTU_WORKER_DEPLOYMENT_ID`, de modo que otro worker sano no puede
ocultar la caida del proceso supervisado.
