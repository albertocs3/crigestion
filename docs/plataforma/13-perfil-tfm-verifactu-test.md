# Perfil temporal TFM con VeriFactu TEST

## Alcance

`gestion.crisoft.es` puede alojar temporalmente datos desechables para la
presentacion y correccion del TFM. Este perfil no autoriza ninguna comunicacion
con AEAT PRODUCCION. Mantiene `APP_ENV=production` para conservar las garantias
de HTTPS, cookies, despliegue y migraciones, pero selecciona exclusivamente el
transporte y los QR de AEAT TEST.

El perfil requiere simultaneamente:

```dotenv
NODE_ENV=production
APP_ENV=production
VERIFACTU_TFM_DEMO_CONFIRM=TFM_DEMO_AEAT_TEST_ONLY
VERIFACTU_ENVIRONMENT=TEST
VERIFACTU_ALLOW_PRODUCTION=false
VERIFACTU_PRODUCTION_RELEASE_ID=
VERIFACTU_WORKER_ENVIRONMENT=TEST
VERIFACTU_WORKER_ALLOW_PRODUCTION=false
VERIFACTU_WORKER_PRODUCTION_CONFIRM=
VERIFACTU_WORKER_EXPECTED_DATABASE=crigestion_prod
```

La conexion debe usar exactamente el rol `crigestion_app`, la base
`crigestion_prod`, loopback y el puerto `5433`. Cualquier desviacion invalida el
perfil. La interfaz muestra permanentemente `ENTORNO TFM DEMO` y `AEAT TEST`.

## Endpoints fijados por codigo

- SOAP estandar TEST: `https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`.
- SOAP sello TEST: `https://prewww10.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`.
- QR TEST: `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR`.

Las URLs no se reciben desde formularios ni variables libres. El entorno
`TEST | PRODUCTION` selecciona un mapa cerrado de hosts AEAT.

## Activacion segura

1. Desplegar primero el perfil con `VERIFACTU_ENABLED=false` y el worker parado.
2. Crear una instalacion SIF TEST desde la aplicacion.
3. Importar un PFX destinado a pruebas, con `allowTest=true` y
   `allowProduction=false`.
4. Probar y activar la version del certificado contra AEAT TEST.
5. Crear una copia verificable de la base.
6. Cambiar `VERIFACTU_ENABLED=true` conjuntamente en web y worker.
7. Habilitar el worker y exigir salud `verifactu=ok` y `worker=ok`.

El perfil rechaza credenciales con capacidad de produccion, instalaciones SIF
productivas, confirmaciones productivas y releases fiscales autorizadas.

## Retirada antes del uso real

1. Detener y deshabilitar el worker.
2. Conservar solo la evidencia del TFM que proceda, sin secretos ni PFX.
3. Destruir la base de demostracion mediante un procedimiento de reinicializacion
   aprobado y verificar que no quedan facturas, registros fiscales, sesiones,
   certificados ni auditoria de prueba.
4. Rotar secretos y keyrings que no deban sobrevivir al TFM.
5. Eliminar `VERIFACTU_TFM_DEMO_CONFIRM` y volver al estado productivo cerrado de
   `docs/plataforma/10-despliegue-plesk-ubuntu.md`.
6. Ejecutar una release fiscal independiente, con copia previa, checklist,
   autorizacion expresa y smoke controlado.

No se convierte una base de demostracion en base real mediante un simple cambio
de variables. La transicion exige borrado verificable, reinicializacion y nueva
evidencia de despliegue.
