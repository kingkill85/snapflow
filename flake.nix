{
  description = "SnapFlow 2 development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            go
            gopls
            sqlc
            goose
            golangci-lint
            postgresql_17
            nodejs_22
            gnumake
          ];
          # Browsers for the Playwright end-to-end tests (`make e2e`). The
          # @playwright/test version in frontend/package.json must equal
          # playwright-driver's version, or the browser revisions do not match.
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers-chromium;
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          PLAYWRIGHT_DRIVER_VERSION = pkgs.playwright-driver.version;
        };
      });
    };
}
