{
  description = "SnapFlow 2 development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      devShells = forAll (pkgs: rec {
        # The default shell plus LibreOffice, for the document tests that
        # convert generated DOCX files to PDF (CI's documents job; locally
        # `nix develop .#documents -c make test-documents`). Kept out of the
        # default shell: LibreOffice is large.
        documents = pkgs.mkShell {
          inputsFrom = [ default ];
          packages = [ pkgs.libreoffice ];
          inherit (default) PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS PLAYWRIGHT_DRIVER_VERSION;
        };
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
