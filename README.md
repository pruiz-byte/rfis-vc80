# RFIs VC80

App web de la matriz de RFIs de Villa Corales 80. Usa Supabase para el inicio de sesión, los permisos por rol y la auditoría, y se publica en Vercel como sitio estático (sin servidor propio ni claves secretas).

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

## Roles (marco normativo Taller 8 · v0.8)
| Rol en la base | Quién | Lee | Escribe | Aprueba |
|---|---|---|---|---|
| admin | Residencia (gestiona usuarios) | Todo, incluida la auditoría | Todo | Cartas y cambios menores |
| residente | Residencia de Obra | Todos los RFIs y la bitácora | RFIs, reiteraciones, propuestas de cambio | Cartas y cambios menores |
| contratista | Contratista / Diseñador | Solo los RFIs de su especialidad (frentes asignados), sin correos del cliente | Respuestas técnicas en sus RFIs abiertos | Nada |
| director | Interventoría / Dirección de Obra | Todo, incluida la auditoría | Observaciones y validaciones | Cambios mayores |
| consulta | Lectura | La matriz | Nada | Nada |

Todo lo anterior lo aplica la base (RLS y funciones `agregar_nota`, `decidir_cambio`); la app solo oculta botones.
Las cuentas nuevas se invitan desde Supabase (Authentication → Users → Invite user) y llegan inactivas; el admin las activa en la pestaña Usuarios y, si es contratista, le asigna la especialidad.
La pestaña **Política** muestra la clasificación de datos y las cinco reglas de uso.
