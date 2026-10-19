// A stand-in for the online exchange rate provider (open.er-api.com format)
// so end-to-end runs never reach the internet: fixed rates, dated yesterday
// (00:00 UTC). Usage: node e2e/rates-stub.ts <port>
import { createServer } from 'node:http'

/** Units per 1 USD the stub answers; specs assert against these. */
export const stubRates: Record<string, number> = { USD: 1, EUR: 0.9237, PKR: 278.5, CHF: 0.8812, GBP: 0.7745 }

const port = Number(process.argv[2])
if (process.argv[1]?.endsWith('rates-stub.ts') && port) {
  createServer((_req, res) => {
    const yesterday = new Date()
    yesterday.setUTCHours(0, 0, 0, 0)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ result: 'success', base_code: 'USD', time_last_update_unix: yesterday.getTime() / 1000, rates: stubRates }))
  }).listen(port)
}
