// Catálogo centralizado de textos de UI en español. Ninguna vista debe
// hardcodear copy inline (mismo patrón que foodc-kds/js/messages.js).

export const messages = {
  pin: {
    title: 'Ingresá el PIN de caja',
    submit: 'Entrar',
    // auth.error states, ver design.md "Caja Access" y el state shape auth.error.
    wrongPin: 'PIN incorrecto. Intente de nuevo.',
    offline: 'Sin conexión, reintente.',
    notConfigured: 'El PIN de caja no está configurado en el servidor. Avise al administrador.',
    contract: 'La caja no puede validar el PIN (versión del servidor incompatible). Use la hoja Orders.',
    lockButton: 'Bloquear',
  },
  sync: {
    connecting: 'Conectando…',
    ok: (time) => `Actualizado ${time}`,
    retrying: (time) => `Reconectando… último dato ${time}`,
    stale: (time) =>
      `Sin conexión con el servidor desde ${time}. Los pedidos pueden no estar al día.`,
    contract:
      'La caja no puede leer pedidos (versión del servidor incompatible). Use la hoja Orders.',
    notConfigured: 'El PIN de caja no está configurado en el servidor. Avise al administrador.',
    staleRibbon: 'Datos sin confirmar',
    emptyQueueOk: 'No hay pedidos pendientes de pago',
    emptyQueueStale: 'Sin conexión: no se puede confirmar si hay pedidos pendientes de pago',
  },
  payment: {
    payButton: 'Pagada',
    // Mark-Pagada Recovery Policy outcomes, ver caja-payment-queue spec.
    // ok:true / NOT_FOUND -> confirmado o descartado (tombstone): la tarjeta ya desapareció, sin texto adicional.
    // UNAUTHORIZED -> re-lock; el pago pendiente se conserva y el runner se pausa hasta
    // que se ingrese el PIN de nuevo (no requiere texto propio: ver pin.* / sync.*).
    // LOCK_TIMEOUT, SHEET_UNAVAILABLE, INTERNAL_ERROR, PIN_NOT_CONFIGURED, INVALID_TRANSITION, ambiguous -> reintento o restauración.
    retrying: 'Reintentando marcar como pagada…',
    // VALIDATION_ERROR, INVALID_JSON, UNKNOWN_ACTION, INVALID_TRANSITION -> la tarjeta vuelve a la lista con aviso.
    restoredNotice: (tableNumber) =>
      `El pedido de la Mesa ${tableNumber} no se pudo marcar como pagada y volvió a la lista.`,
    restoredDismiss: 'Entendido',
  },
  close: {
    openButton: 'Cerrar día',
    pinTitle: 'Ingresá el PIN de caja para cerrar el día',
    pinSubmit: 'Continuar',
    confirmTitle: '¿Seguro que querés cerrar el día?',
    confirmBody: 'Esta acción archiva los pedidos pagados del día y no se puede deshacer.',
    confirmAccept: 'Sí, cerrar día',
    confirmCancel: 'Cancelar',
    // Preview shown on the "¿Seguro?" step, from getCajaOrders status:"Pagada"
    // (optional-for-the-client preview per design.md Decision 3's rationale;
    // never blocks the close itself if this read fails — see confirmSummaryUnavailable).
    confirmSummaryLoading: 'Calculando pedidos pagados…',
    confirmSummary: (count, total) => `Se van a archivar ${count} pedidos pagados por un total de ${total}.`,
    confirmSummaryUnavailable: 'No se pudo calcular el total a cerrar. Podés continuar de todos modos.',
    running: 'Procesando el cierre de día…',
    // close.status result states, ver design.md "js/close.js" (classifyCloseResult) y
    // caja-day-close-flow spec.
    done: (count, total) => `Cierre completo: ${count} pedidos archivados por un total de ${total}.`,
    alreadyClosed: 'El día ya fue cerrado. No se creó un nuevo archivo ni se envió otro correo.',
    nothing: 'No hay pedidos pagados para cerrar hoy.',
    inProgress: 'Ya hay un cierre en curso. Esperá unos minutos y volvé a intentar.',
    failed: (step) =>
      step
        ? `Falló el paso "${step}". No se borró ningún pedido. Podés reintentar.`
        : 'Falló el cierre. No se borró ningún pedido. Podés reintentar.',
    unknown: 'No se pudo confirmar el resultado del cierre. Reintentar es seguro.',
    blocked: 'El cierre no está configurado correctamente. Avise al administrador.',
    contract: 'La caja no puede cerrar el día (versión del servidor incompatible). Use la hoja Orders.',
    retry: 'Reintentar',
    dismiss: 'Entendido',
  },
};
