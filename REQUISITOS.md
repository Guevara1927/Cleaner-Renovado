# CleanerDev – Requisitos e instalación

## Instalación rápida

1. Haz **doble clic en `Instalar.bat`**.
2. Acepta el aviso de Windows (UAC) para dar permisos de administrador.
3. El instalador hace todo solo:
   1. **Analiza** tu equipo y muestra qué herramientas tienes y cuáles faltan.
   2. **Instala** lo que falte (Node.js LTS y las dependencias del proyecto).
   3. **Genera** `CleanerDev.exe`.
   4. Te avisa con el mensaje **"LISTO: YA PUEDES EJECUTAR EL .EXE"** y te ofrece abrirlo.

Resultado: `CleanerDev.exe` en la carpeta del proyecto (copia también en `release\`). Registro de lo ocurrido en `instalador.log`.

> Solo quieres ver qué te falta, sin instalar nada: `Instalar.bat -SoloAnalizar`

---

## Requisitos del sistema

| Requisito | Mínimo | Recomendado | ¿Lo instala el instalador? |
|---|---|---|---|
| Sistema operativo | Windows 10 (64 bits) | Windows 11 | No |
| PowerShell | 5.1 (viene con Windows) | 5.1 | No |
| Permisos | Administrador (instalación y uso completo) | – | Solicita elevación (UAC) |
| RAM | 4 GB | 8 GB o más | No |
| Espacio en disco | 2 GB libres (para compilar) | 3 GB | No |
| Conexión a internet | Necesaria la primera vez | – | – |

### Software

| Herramienta | Versión | Para qué se usa | ¿Lo instala el instalador? |
|---|---|---|---|
| **Node.js** | 18 o superior (se instala la LTS actual) | Ejecutar y compilar el proyecto | Sí (winget o instalador oficial) |
| **npm** | Incluido con Node.js | Descargar dependencias | Sí (con Node.js) |
| **Electron** | 33 (en `package.json`) | Aplicación de escritorio | Sí (`npm install`) |
| **electron-builder** | 25 (en `package.json`) | Genera el `.exe` | Sí (`npm install`) |
| **.NET Framework 4.x** | Viene con Windows 10/11 | Compilador `csc.exe` para el escáner de disco y el limpiador de RAM | No (ya está en Windows) |
| **winget** | Opcional | Instalación automática de Node.js | No (si falta, se descarga el instalador oficial) |

> No necesitas Git, Python, Visual Studio ni ningún IDE.

### Descargas durante la instalación (aprox.)

| Qué | Tamaño |
|---|---|
| Node.js LTS (si falta) | ~30 MB |
| Electron | ~110 MB |
| electron-builder y herramientas de empaquetado | ~50 MB |
| Dependencias en `node_modules` | ~400 MB |
| `CleanerDev.exe` resultante | ~75 MB |

---

## Permisos de administrador: por qué se piden

- **Al instalar:** instalar Node.js y que `electron-builder` pueda crear enlaces simbólicos al empaquetar.
- **Al usar la app:** el `.exe` se abre pidiendo administrador porque estas funciones lo necesitan:
  - Borrado **forzoso** (tomar propiedad de archivos, cerrar procesos que los usan).
  - Limpieza de **Temp de Windows, Prefetch y Windows Update**.
  - Vaciado de la **caché de espera de la RAM** (limpieza profunda).
  - Finalizar procesos de otros usuarios o del sistema.
  - Contar **todas** las carpetas al analizar un disco (sin administrador, Windows bloquea cientos de carpetas del sistema).

Sin administrador la app funciona, pero con esas partes limitadas.

---

## Qué hace la app en tu equipo (para tenerlo en cuenta)

- Al abrirse por primera vez **compila dos pequeños programas** (`diskscan` y `ramclean`) con el compilador de Windows y los guarda en `%APPDATA%\cleanerdev\`. Tarda unos segundos solo esa vez.
- Usa PowerShell y utilidades nativas de Windows (`taskkill`, `takeown`, `icacls`, `robocopy`, `tasklist`, `ipconfig`).
- **El borrado es permanente** (no pasa por la papelera). Hay rutas protegidas que nunca se borran (`C:\Windows`, raíces de unidad, `Program Files`, carpetas de usuario, etc.).
- La limpieza de RAM no cierra programas; recorta la memoria inactiva. Parte de lo liberado se vuelve a ocupar cuando los programas lo necesitan.

---

## Posibles avisos y soluciones

| Síntoma | Causa | Solución |
|---|---|---|
| SmartScreen: "Windows protegió su PC" | El `.exe` no está firmado digitalmente | **Más información → Ejecutar de todas formas** |
| El antivirus marca el `.exe` o `diskscan.exe` | Programas sin firma que leen memoria/disco | Añade una excepción para la carpeta del proyecto y `%APPDATA%\cleanerdev` |
| `Cannot create symbolic link` al compilar | El instalador no se ejecutó como administrador | Ejecuta `Instalar.bat` y acepta el UAC, o activa el **Modo desarrollador** de Windows |
| "Node.js se instaló pero no se detecta" | La ventana no vio el PATH nuevo | Cierra la ventana y ejecuta `Instalar.bat` otra vez |
| `npm install` falla | Sin internet, proxy o firewall | Revisa la conexión; en redes con proxy configura `npm config set proxy` |
| "La ejecución de scripts está deshabilitada" | Política de PowerShell | Usa siempre `Instalar.bat` (ya incluye `-ExecutionPolicy Bypass`) |
| El `.exe` no pide administrador | Se usó el modo compatible de compilación | Usa el botón **"Reiniciar como administrador"** dentro de la app, o clic derecho → *Ejecutar como administrador* |
| Falta .NET Framework 4 | Instalación de Windows modificada | La app funciona en modo compatible (análisis más lento, sin limpieza profunda de RAM) |

---

## No compatible

- Windows 7 / 8 / 8.1 y Windows de 32 bits.
- macOS y Linux (la app depende de APIs y utilidades de Windows).
- Windows ARM no está probado.

---

## Ejecutar sin generar el .exe (modo desarrollo)

```bat
Iniciar.bat
```
o, desde una terminal en la carpeta del proyecto:
```bash
npm install
npm start
```

## Archivos del instalador

| Archivo | Función |
|---|---|
| `Instalar.bat` | Punto de entrada (doble clic) |
| `Instalar.ps1` | Análisis, instalación y compilación |
| `instalador.log` | Registro de la última ejecución |
| `Iniciar.bat` | Abre la app en modo desarrollo |
| `CleanerDev.exe` | Resultado final |
