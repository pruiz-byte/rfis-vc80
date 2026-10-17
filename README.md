# RFIs VC80

App web de la matriz de RFIs de Villa Corales 80. Usa Supabase para el inicio de sesión, los permisos por rol y la auditoría, y se publica en Vercel como sitio estático (sin servidor propio ni claves secretas).

## Archivos
- `index.html`: pantallas (inicio de sesión, matriz, nuevo RFI, auditoría, usuarios, ajustes).
- `app.js`: lógica de la app.
- `styles.css`: diseño.
- `config.js`: dirección y clave publicable de Supabase. La clave publicable está hecha para ir en el navegador; los permisos los aplica la base por rol. Nunca pongas aquí la clave secreta.

## Publicar en Vercel
1. Sube estos archivos a un repositorio de GitHub.
2. En vercel.com: Add New → Project → importa el repositorio.
3. Framework Preset: Other. Sin comando de build. Output: la raíz. Deploy.

## Después de publicar (obligatorio)
En Supabase → Authentication → URL Configuration:
- Site URL: la dirección que te dio Vercel (por ejemplo `https://rfis-vc80.vercel.app`).
- Redirect URLs: agrega la misma dirección.

Sin esto, los enlaces de acceso siguen llevando a `localhost:3000`.

## Roles
| Rol | Ve | Cambia |
|---|---|---|
| admin | Todo, incluida la auditoría | Todo; activa usuarios y asigna roles |
| residente | Matriz, bitácora, ajustes | RFIs, bitácora, ajustes |
| director | Todo, incluida la auditoría | Nada |
| consulta | Matriz | Nada |

Las cuentas nuevas se invitan desde Supabase (Authentication → Users → Invite user) y llegan inactivas; el admin las activa en la pestaña Usuarios.
