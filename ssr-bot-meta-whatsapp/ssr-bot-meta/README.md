# 🏗️ SS Remodelaciones — WhatsApp Bot *Sasha*
### Meta WhatsApp Business API + Claude AI

---

## ✨ Funciones del bot

| Función | Descripción |
|---|---|
| 🤖 Respuestas inteligentes | Claude AI responde preguntas con contexto de SSR |
| 📋 Captura de leads | Registra nombre, proyecto y zona automáticamente |
| 🗓️ Agendamiento de visitas | Flujo completo: datos → confirmación → pago SINPE ₡25.000 |
| 📲 Escalación a Melvin | Notifica automáticamente cuando el cliente lo pide |
| ✅ Doble check azul | Marca mensajes como leídos en tiempo real |

---

## 🛠️ SETUP DESDE CERO — Paso a paso

### PASO 1 — Crear cuenta de Meta Developer

1. Ir a **https://developers.facebook.com**
2. Clic en *Get Started* e iniciá sesión con tu cuenta de Facebook
3. Aceptar las condiciones de desarrollador

---

### PASO 2 — Crear la App de Meta

1. En el dashboard → **Create App**
2. Tipo de App: **Business**
3. Nombre: `SS Remodelaciones Bot` (o el que querás)
4. Conectar a tu cuenta de **Meta Business Manager** (si no tenés, creá una en business.facebook.com)
5. Clic en **Create App**

---

### PASO 3 — Agregar WhatsApp al App

1. En el panel de tu App → **Add a Product**
2. Buscá **WhatsApp** y clic en **Set Up**
3. Seleccioná tu cuenta de Meta Business Manager
4. En la sección **API Setup** vas a ver:
   - **Phone Number ID** → copialo (esto es `WHATSAPP_PHONE_NUMBER_ID`)
   - **Temporary Access Token** → copialo (esto es `WHATSAPP_TOKEN` temporal)

> ⚠️ El token temporal expira en 24h. Ver Paso 6 para generar uno permanente.

---

### PASO 4 — Registrar un número de WhatsApp Business

**Opción A: Usar el número de prueba de Meta** (para testear, gratis)
- En API Setup, Meta te da un número de prueba
- Podés enviar mensajes de prueba a hasta 5 números registrados

**Opción B: Agregar tu número real de WhatsApp Business**
1. En **Phone Numbers** → Add Phone Number
2. Ingresá el número de WhatsApp Business de SSR
3. Verificar por SMS o llamada
4. El número queda vinculado al sistema

---

### PASO 5 — Deploy del servidor

**Con Railway (recomendado):**
1. Creá cuenta en **https://railway.app**
2. New Project → Deploy from GitHub
   - Subí el código a un repositorio en GitHub primero
3. Railway genera automáticamente una URL pública tipo:
   `https://ssr-bot-meta-production.up.railway.app`
4. En Railway → Variables → agregá todas las del `.env.example`

**Con Render:**
1. Cuenta en **https://render.com**
2. New → Web Service → conectar GitHub repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Agregar variables de entorno en el dashboard

---

### PASO 6 — Configurar el Webhook en Meta

1. En tu App de Meta → WhatsApp → **Configuration**
2. En **Webhook** → Edit
3. Callback URL: `https://tu-url.railway.app/webhook`
4. Verify Token: el mismo que pusiste en `WEBHOOK_VERIFY_TOKEN` en el .env
5. Clic en **Verify and Save**
   - Meta hace un GET a tu URL para verificar → el servidor responde con el challenge
6. En **Webhook Fields** → suscribirse a: `messages`

---

### PASO 7 — Generar Token Permanente (obligatorio para producción)

El token temporal expira en 24h. Para producción:

1. Ir a **https://business.facebook.com/settings/system-users**
2. **Add** → crear un System User de tipo *Admin*
3. Asignarle permisos a la App: `whatsapp_business_messaging`, `whatsapp_business_management`
4. Generar Token → seleccioná tu App → los permisos mencionados → **Generate Token**
5. Copiar el token y guardarlo en `WHATSAPP_TOKEN` del .env

---

### PASO 8 — Verificar que todo funciona

1. Mandarte un mensaje de prueba desde WhatsApp al número configurado
2. El bot debería responder como Sasha en segundos
3. Revisar logs del servidor: `railway logs` o en el dashboard de Render

---

## 📁 Estructura del proyecto

```
ssr-bot-meta/
├── server.js              # Express + webhook Meta
├── bot/
│   ├── index.js           # Orquestador: flujo principal + agendamiento
│   ├── claude.js          # Integración Claude AI (system prompt SSR)
│   ├── messenger.js       # Envío de mensajes vía Meta Graph API
│   ├── state.js           # Estado de conversaciones en memoria
│   └── knowledge.js       # Base de conocimiento SSR
├── .env.example           # Variables requeridas
├── railway.toml           # Config Railway
└── README.md
```

---

## 🎯 Flujo de agendamiento de visita

```
Cliente: "quiero agendar una visita"
    ↓
Sasha: ¿Cuál es tu nombre?
    ↓
Sasha: ¿Qué tipo de proyecto?
    ↓
Sasha: ¿En qué zona está la propiedad?
    ↓
Sasha: ¿Qué día preferís? [Entre semana / Sábado / Cualquier día]
    ↓
Sasha: Resumen + confirmación [Confirmar / Cambiar algo]
    ↓
Sasha: Instrucciones SINPE ₡25.000 → número de Melvin
    ↓
Cliente manda comprobante
    ↓
Sasha: Confirma recibido + avisa que Melvin coordina
Melvin recibe notificación automática con todos los datos ✅
```

---

## 🔧 Personalización rápida

| Qué cambiar | Dónde |
|---|---|
| Precio de visita | `bot/knowledge.js` → `visita.costo` |
| Número SINPE de cobro | `bot/knowledge.js` → `empresa.sinpe_numero` |
| Servicios ofrecidos | `bot/knowledge.js` → `servicios` |
| FAQ | `bot/knowledge.js` → `preguntas_frecuentes` |
| Tono/personalidad de Sasha | `bot/claude.js` → `SYSTEM_PROMPT` |
| Número de escalación | `bot/knowledge.js` → `empresa.whatsapp_melvin` |

---

## 💬 Comando de prueba

| Mensaje | Resultado |
|---|---|
| `/reset` | Reinicia la conversación (solo en desarrollo) |

---

## 📞 Escalación a Melvin Zúñiga — +506 7198-1370

Cuando el bot escala, Melvin recibe un resumen automático con: número del cliente, nombre, proyecto, zona y último mensaje.
