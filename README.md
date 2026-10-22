# RFIs · Lápiz de Sueños

App web de la matriz de RFIs de los proyectos de Lápiz de Sueños (empezó con Villa Corales 80). Usa Supabase para el inicio de sesión, los permisos por rol y la auditoría, y se publica en Vercel como sitio estático (sin servidor propio ni claves secretas).

## Archivos
- `index.html`: pantallas (inicio de sesión, matriz, nuevo RFI, auditoría, usuarios, ajustes).
- `app.js`: lógica de la app.
- `styles.css`: diseño.
- `demo.js`: datos ficticios y cliente de solo lectura para la demo sin usuario.
- `img/`: logos de Lápiz de Sueños (negro y blanco).
- `config.js`: dirección y clave publicable de Supabase. La clave publicable está hecha para ir en el navegador; los permisos los aplica la base por rol. Nunca pongas aquí la clave secreta.

## Demo sin usuario
`https://rfis-vc80.vercel.app/?demo` (o el botón **Ver la demo** en el inicio de sesión) abre la app con **datos ficticios** de `demo.js`, en solo lectura y sin conectarse a la base. Con `?demo=contratista`, `?demo=director`, `?demo=consulta` o `?demo=admin` se ve lo que ve cada rol. La matriz real es información interna y nunca se muestra sin sesión.

## Publicar en Vercel
1. Sube estos archivos a un repositorio de GitHub.
2. En vercel.com: Add New → Project → importa el repositorio.
3. Framework Preset: Other. Sin comando de build. Output: la raíz. Deploy.

## Después de publicar (obligatorio)
En Supabase → Authentication → URL Configuration:
- Site URL: la dirección que te dio Vercel (por ejemplo `https://rfis-vc80.vercel.app`).
- Redirect URLs: agrega la misma dirección.

Sin esto, los enlaces de acceso siguen llevando a `localhost:3000`.

## Proyectos y roles (21/10/2026)
- Cada proyecto tiene código (2 a 8 letras o números), nombre, cliente, días de tolerancia y cese. Sus RFIs llevan la llave `RFI-<código>-NNN` con consecutivo propio, y un RFI no se puede mover de proyecto.
- El admin (rol global) ve y gestiona todos los proyectos: los crea en la pestaña **Proyectos** y asigna a cada persona su rol **por proyecto** en **Usuarios**.
- Los demás roles valen solo en el proyecto asignado:

| Rol | Lee | Escribe | Aprueba |
|---|---|---|---|
| residente | Todos los RFIs y la bitácora del proyecto | RFIs, reiteraciones, propuestas de cambio, ajustes del proyecto | Cartas y cambios menores |
| contratista | Solo los RFIs de sus frentes en ese proyecto, sin correos del cliente | Respuestas técnicas en sus RFIs abiertos | Nada |
| director (Interventoría) | Todo el proyecto, incluida su auditoría | Observaciones | Cambios mayores |
| consulta | La matriz del proyecto | Nada | Nada |

Todo lo aplica la base (RLS con `rol_en(proyecto)` y funciones `crear_rfi`, `agregar_nota`, `decidir_cambio`); la app solo oculta botones.
