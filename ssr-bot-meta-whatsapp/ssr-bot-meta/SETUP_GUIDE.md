# 🚀 GUÍA DE ACTIVACIÓN — SS Remodelaciones WhatsApp Bot
### Para quien ya tiene número de WhatsApp Business pero no ha configurado la App de Meta

---

## ¿Qué vas a necesitar tener a mano?

- [ ] Acceso al Facebook/Meta del negocio (o crear uno)
- [ ] El número de WhatsApp Business de SSR (ya lo tenés ✅)
- [ ] Una cuenta en GitHub (gratis) para subir el código
- [ ] Una cuenta en Railway (gratis) para alojar el bot
- [ ] Tu API Key de Anthropic (console.anthropic.com)
- [ ] ~30 minutos

---

## FASE 1 — Preparar Meta Business (15 min)

### 1.1 Crear Meta Business Manager (si no tenés)
1. Ir a **https://business.facebook.com**
2. Crear cuenta con tu Facebook personal
3. Nombre del negocio: `SS Remodelaciones`

### 1.2 Crear la App de desarrollador
1. Ir a **https://developers.facebook.com/apps**
2. Clic en **Create App**
3. Elegir: **Business** → Next
4. App name: `SSR Bot` | Contact email: el tuyo
5. Business Account: seleccioná SS Remodelaciones
6. **Create App**

### 1.3 Agregar WhatsApp a la App
1. En el dashboard de tu App nueva → **Add a Product**
2. Encontrá **WhatsApp** → clic en **Set Up**
3. Aceptar términos → seleccionar tu Business Account

### 1.4 Vincular tu número de WhatsApp Business existente
1. En el panel de WhatsApp → **Getting Started** → **Step 1: Select a phone number**
2. Clic en **Add phone number**
3. Ingresá el número de SSR (con código de país: +506...)
4. Verificación: elegí **Text message** o **Phone call**
5. Ingresá el código de 6 dígitos que recibís

> ⚠️ **Importante:** El número debe estar registrado como WhatsApp Business
> y no puede estar activo en la app normal de WhatsApp al mismo tiempo.
> Si actualmente lo usás en el teléfono, Meta te pedirá migrar a la API.

### 1.5 Anotar credenciales (las vas a necesitar)
En **WhatsApp → API Setup** copiá y guardá:
```
Phone Number ID:   ________________ (ej: 123456789012345)
WhatsApp Business Account ID: ________________
Temporary access token: ________________ (expira en 24h, después generamos uno permanente)
```

---

## FASE 2 — Subir el código a Railway (10 min)

### 2.1 Crear repositorio en GitHub
1. Ir a **https://github.com** → New repository
2. Nombre: `ssr-whatsapp-bot` | Privado ✅
3. Descomprimí el ZIP del bot en tu computadora
4. Subir los archivos al repo (podés arrastrarlo en la web de GitHub)

### 2.2 Deploy en Railway
1. Ir a **https://railway.app** → Log in with GitHub
2. **New Project** → Deploy from GitHub Repo
3. Seleccioná `ssr-whatsapp-bot`
4. Railway detecta el `railway.toml` automáticamente → Deploy

### 2.3 Agregar variables de entorno en Railway
En tu proyecto de Railway → **Variables** → agregar una por una:

| Variable | Valor |
|---|---|
| `WHATSAPP_TOKEN` | El token temporal de Meta (Paso 1.5) |
| `WHATSAPP_PHONE_NUMBER_ID` | El Phone Number ID (Paso 1.5) |
| `WEBHOOK_VERIFY_TOKEN` | Inventá un string seguro, ej: `ssr2026bot$ecure` |
| `ANTHROPIC_API_KEY` | Tu key de console.anthropic.com |
| `NODE_ENV` | `production` |

### 2.4 Copiar tu URL de Railway
En Railway → tu servicio → **Settings** → **Domains** → copiá la URL
```
Ejemplo: https://ssr-whatsapp-bot-production.up.railway.app
```

---

## FASE 3 — Conectar Meta con tu servidor (5 min)

### 3.1 Configurar el Webhook
1. En Meta → tu App → WhatsApp → **Configuration**
2. En la sección **Webhook** → **Edit**
3. Callback URL: `https://TU-URL-DE-RAILWAY.app/webhook`
4. Verify Token: el mismo que pusiste en `WEBHOOK_VERIFY_TOKEN`
5. Clic en **Verify and Save**
   → Si aparece ✅ verde, funcionó. Si da error, revisá los logs en Railway.

### 3.2 Suscribirse a mensajes
1. En la misma pantalla de Webhook → **Webhook Fields**
2. Activar: **messages** ✅
3. Clic en **Subscribe**

### 3.3 Test rápido
Mandá un mensaje de WhatsApp al número de SSR.
Si el bot responde → ¡todo funcionando! 🎉

---

## FASE 4 — Token permanente (hacer antes de los 24h)

El token temporal expira. Para uno permanente:

1. Ir a **https://business.facebook.com/settings/system-users**
2. **Add** → Nombre: `SSR Bot API` | Rol: **Admin**
3. **Add Assets** → Apps → tu App `SSR Bot` → permisos: **Full Control**
4. **Generate New Token** → seleccioná tu App
5. Permisos a marcar:
   - `whatsapp_business_messaging` ✅
   - `whatsapp_business_management` ✅
6. **Generate Token** → copiarlo
7. En Railway → Variables → actualizar `WHATSAPP_TOKEN` con el nuevo token permanente

---

## ✅ Checklist final

- [ ] App de Meta creada y número vinculado
- [ ] Bot desplegado en Railway con las 5 variables
- [ ] Webhook configurado y verificado (✅ verde en Meta)
- [ ] Suscrito al campo `messages`
- [ ] Token permanente generado y actualizado en Railway
- [ ] Prueba de conversación exitosa
- [ ] Melvin recibe notificación cuando se agenda una visita

---

## 🆘 Problemas comunes

| Problema | Solución |
|---|---|
| Webhook da error de verificación | Revisá que `WEBHOOK_VERIFY_TOKEN` sea exactamente igual en Railway y en Meta |
| El bot no responde | Verificá en Railway logs que no haya errores de variables |
| Token expirado | Generar token permanente (Fase 4) |
| El número no se puede vincular | El número debe ser WhatsApp Business, no personal |
| Railway no despliega | Verificar que el repo tiene `server.js` y `package.json` en la raíz |

---

## 📞 Si necesitás ayuda técnica

Revisá los logs en tiempo real:
- **Railway:** dashboard → tu servicio → **Deployments** → **View Logs**
- O con Railway CLI: `railway logs`
