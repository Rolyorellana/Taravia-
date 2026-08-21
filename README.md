# TARAVÍA v1.4

Aplicación web con backend para que Chrome no tenga que consultar directamente las APIs externas.

## Incluye
- Dashboard web.
- Open-Meteo desde servidor.
- MOP Emergencias Vialidad desde servidor.
- DMC opcional mediante variables de entorno `DMC_USER` y `DMC_TOKEN`.
- Índice Peter.
- Histórico de cortes en el servidor.
- Endpoint `/api/snapshot` para automatizar 06:00, 14:00 y 22:00.
- Estado independiente de las fuentes.

## Publicar en Render
1. Sube este proyecto a un repositorio GitHub.
2. En Render: New + Web Service.
3. Conecta el repositorio `taravia`.
4. Runtime: Node.
5. Build command: `npm install`
6. Start command: `npm start`
7. Deploy.
8. Abre la URL que Render entregue.

## Importante sobre el histórico
La v1.4 guarda el histórico en `/tmp`, útil para pruebas pero no persistente ante todos los reinicios/redeploys. Para producción se debe añadir Postgres o almacenamiento persistente.

## Automatización
El endpoint `POST /api/snapshot` está listo para recibir un scheduler. En la siguiente etapa se puede añadir Render Cron + almacenamiento persistente para que los cortes se registren aunque el navegador esté cerrado.
