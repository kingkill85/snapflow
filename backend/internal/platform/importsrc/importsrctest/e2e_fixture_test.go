package importsrctest

import (
	"image/color"
	"os"
	"testing"
)

// TestE2EFixture writes frontend/e2e/assets/import-v1.xlsx, the workbook
// the import's end-to-end spec uploads, when UPDATE_E2E_FIXTURE=1:
//
//	UPDATE_E2E_FIXTURE=1 go test ./internal/platform/importsrc/importsrctest -run TestE2EFixture
func TestE2EFixture(t *testing.T) {
	if os.Getenv("UPDATE_E2E_FIXTURE") != "1" {
		t.Skip("set UPDATE_E2E_FIXTURE=1 to write the e2e fixture")
	}
	red, blue := color.RGBA{220, 38, 38, 255}, color.RGBA{37, 99, 235, 255}
	data := V1Workbook(t, []V1Row{
		{Category: "E2E Gateways", Name: "E2E Zigbee Gateway", Description: "Gateway for the e2e import", Model: "E2E-GW-1",
			Dimensions: "45*47*19", Style: "White", Price: 120, Images: [][]byte{PNG(t, red)}},
		{Category: "E2E Gateways", Name: "E2E Zigbee Gateway", Model: "E2E-GW-1", Dimensions: "45*47*19", Style: "Black", Price: 125},
		{Spacer: true},
		{Category: "E2E Dimmers", Name: "E2E Dimmer 2ch", Description: "Two channels", Model: "E2E-DIM-2", Dimensions: "86*86*10",
			Price: "45,5", Required: []string{"E2E-GW-1 White"}, Optional: []string{"E2E-PSU-9"}, Images: [][]byte{PNG(t, blue)}},
	})
	if err := os.WriteFile("../../../../../frontend/e2e/assets/import-v1.xlsx", data, 0o644); err != nil {
		t.Fatal(err)
	}
}
