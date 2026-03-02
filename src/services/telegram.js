export async function sendTelegramMessage(token, chatId, message) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
    }),
  })

  const data = await response.json()
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description}`)
  }
  return data
}

export async function notifyNewLicensePurchased({
  licenseName,
  price,
  currency,
  originalPrice,
  originalCurrency,
  invoice,
  payment,
  customer,
  subscriptionToken,
  endDate,
  isFirstTimePayment,
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.warn('Telegram token or chatId not configured, skipping notification')
    return
  }

  const message =
    `${licenseName || 'License'} purchased for ${price && currency ? `${price} ${currency}` : ''}${
      originalPrice && originalCurrency ? ` (${originalPrice} ${originalCurrency})` : ''
    }!\n\n` +
    (isFirstTimePayment ? '🎉 First time payment!\n' : '') +
    (!customer ? '' : `- Customer: ${customer?.email} (${customer?.country || 'Unknown'})\n`) +
    (!subscriptionToken ? '' : `- Token: ${subscriptionToken}\n`) +
    (!endDate ? '' : `- End Date: ${endDate}\n`) +
    (!invoice ? '' : `- Invoice:    ${invoice ? '✅' : '❌'}\n`) +
    (!payment ? '' : `- Payment: ${payment ? '✅' : '❌'}`)

  if (process.env.NODE_ENV !== 'production') {
    console.log('Telegram message\n', message)
    return
  }

  try {
    await sendTelegramMessage(token, chatId, message)
  } catch (err) {
    console.error('Failed to send telegram message', err)
  }
}
