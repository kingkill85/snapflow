package money

import (
	"slices"
	"strings"
)

// minorUnits are the ISO 4217 minor units of the currencies that do not have
// 2 decimals (ISO 4217 list, amendment 176). Every other code has 2.
var minorUnits = map[string]int32{
	// 0 decimals
	"BIF": 0, "CLP": 0, "DJF": 0, "GNF": 0, "ISK": 0, "JPY": 0, "KMF": 0, "KRW": 0,
	"PYG": 0, "RWF": 0, "UGX": 0, "UYI": 0, "VND": 0, "VUV": 0, "XAF": 0, "XOF": 0, "XPF": 0,
	// 3 decimals
	"BHD": 3, "IQD": 3, "JOD": 3, "KWD": 3, "LYD": 3, "OMR": 3, "TND": 3,
	// 4 decimals
	"CLF": 4, "UYW": 4,
}

// MinorUnits returns the decimals of an ISO 4217 currency code (2 unless
// listed otherwise).
func MinorUnits(currency string) int32 {
	if n, ok := minorUnits[currency]; ok {
		return n
	}
	return 2
}

// Format formats an amount of currency with its minor unit.
func Format(a Amount, currency string) string { return String(a, MinorUnits(currency)) }

// codes are the active ISO 4217 currency codes (amendment 176), without
// funds codes, precious metals and testing codes.
var codes = strings.Fields(`
AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD
CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD
GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT
LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR
NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP
STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG
XOF XPF YER ZAR ZMW ZWG`)

// Currencies are the ISO 4217 codes a project may use, sorted.
func Currencies() []string { return slices.Clone(codes) }

// IsCurrency reports whether code is one of Currencies.
func IsCurrency(code string) bool { _, ok := slices.BinarySearch(codes, code); return ok }
