import {countries} from './countries.js'

export async function createInvoiceXpress({
  itemName,
  itemDescription,
  clientReference,
  vatNumber = '999999990',
  clientEmail,
  clientName,
  address,
  postalCode,
  city,
  country,
  amount,
  taxExemptionCode,
  taxName,
  sendByEmail = false,
  currencyCode = 'EUR',
  rate = 1,
}) {
  const apiKey = process.env.INVOICEXPRESS_APIKEY
  const accountName = process.env.INVOICEXPRESS_USER

  if (!apiKey || !accountName) {
    console.warn('InvoiceXpress credentials missing, skipping invoice creation.')
    return null
  }

  const documentType = 'invoice_receipts'
  const url = `https://${accountName}.app.invoicexpress.com/${documentType}.json?api_key=${apiKey}`

  const rateString = Number(rate).toFixed(5)
  const amountString = Number(amount).toFixed(2)

  const invoiceData = {
    invoice: {
      date: new Date().toLocaleDateString('en-GB'), // Current date in dd/mm/yyyy format
      due_date: new Date().toLocaleDateString('en-GB'), // Current date in dd/mm/yyyy format
      client: {
        name: clientName,
        code: clientReference,
        email: clientEmail,
        address: address || 'Unknown',
        postal_code: postalCode || '0000-000',
        city: city || 'Unknown',
        country: country || 'Unknown',
        ...(vatNumber && {fiscal_id: vatNumber}),
      },
      currency_code: currencyCode,
      rate: rateString, // Assuming rate is a multiplier for the amount
      ...(taxExemptionCode && {tax_exemption: taxExemptionCode}),
      items: [
        {
          name: itemName,
          description: itemDescription,
          unit_price: amountString,
          quantity: 1,
          ...(taxName && {
            tax: {
              name: taxName,
            },
          }),
        },
      ],
    },
  }

  console.log('Creating invoice_receipts with data:', JSON.stringify(invoiceData))

  const options = {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(invoiceData),
  }

  try {
    const response = await fetch(url, options)
    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
    } catch (e) {
      console.error('Non-JSON response from InvoiceXpress', text)
      throw new Error('Failed to parse InvoiceXpress response')
    }

    if (!response.ok) {
      console.error('InvoiceXpress error:', data)
      throw new Error(`InvoiceXpress creation failed: ${response.status}`)
    }

    console.log('Invoice created successfully:', data?.invoice_receipt?.id || data?.invoice?.id)

    // Finalize invoice
    if (data?.invoice_receipt?.id || data?.invoice?.id) {
      const documentId = data?.invoice_receipt?.id || data?.invoice?.id
      const finalisedInvoice = await changeInvoiceStatus({
        invoiceId: documentId,
        status: 'finalized',
      })
      console.log('Invoice finalised successfully:', finalisedInvoice?.invoice_receipt?.state || 'finalized')

      if (sendByEmail) {
        await sendInvoiceByEmail({
          documentId: documentId,
          email: clientEmail,
          itemDescription,
          itemName,
        })
      }
    }

    return data?.invoice_receipt || data?.invoice
  } catch (error) {
    console.error('Error creating invoice:', error)
    throw error
  }
}

export async function changeInvoiceStatus({invoiceId, status}) {
  const apiKey = process.env.INVOICEXPRESS_APIKEY
  const accountName = process.env.INVOICEXPRESS_USER
  const documentType = 'invoice_receipts'

  const url = `https://${accountName}.app.invoicexpress.com/${documentType}/${invoiceId}/change-state.json?api_key=${apiKey}`

  const statusData = {
    invoice: {
      state: status,
    },
  }

  console.log('Changing invoice status to:', status, url)

  const options = {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(statusData),
  }

  try {
    const response = await fetch(url, options)
    const text = await response.text()
    const data = text ? JSON.parse(text) : {}
    return data
  } catch (error) {
    console.error('Error changing invoice status:', error)
    throw error
  }
}

export async function sendInvoiceByEmail({documentId, email, itemName, itemDescription}) {
  const apiKey = process.env.INVOICEXPRESS_APIKEY
  const accountName = process.env.INVOICEXPRESS_USER
  const documentType = 'invoices'

  const url = `https://${accountName}.app.invoicexpress.com/${documentType}/${documentId}/email-document.json?api_key=${apiKey}`

  const emailData = {
    message: {
      client: {email: email, save: '0'},
      subject: 'Invoice from Personal Software',
      body: `Please find attached the invoice for the ${itemName} subscription.\n\n${itemDescription}`,
      // bcc: 'nabaisaomar@gmail.com',
      logo: '0',
    },
  }

  console.log('Sending invoice by email to:', email)

  const options = {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(emailData),
  }

  try {
    const response = await fetch(url, options)
    const text = await response.text()
    const data = text ? JSON.parse(text) : {}
    console.log('Invoice sent by email successfully')
    return data
  } catch (error) {
    console.error('Error sending invoice by email:', error)
    throw error
  }
}
