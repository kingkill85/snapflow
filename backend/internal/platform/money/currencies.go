package money

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
