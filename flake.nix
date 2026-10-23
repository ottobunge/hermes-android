{
  description = "Hermes Android build environment (JDK + Android SDK)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config.android_sdk.accept_license = true;
        config.allowUnfree = true;
      };
      androidComposition = pkgs.androidenv.composeAndroidPackages {
        cmdLineToolsVersion = "13.0";
        platformToolsVersion = "37.0.1";
        buildToolsVersions = [ "35.0.0" ];
        platformVersions = [ "35" ];
        includeNDK = false;
        includeEmulator = false;
      };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          androidComposition.androidsdk
          pkgs.jdk17
          pkgs.nodejs_22
        ];
        ANDROID_HOME = "${androidComposition.androidsdk}/share/android-sdk";
        ANDROID_SDK_ROOT = "${androidComposition.androidsdk}/share/android-sdk";
        JAVA_HOME = "${pkgs.jdk17}/lib/openjdk";
        # Gradle's aapt2/AAPT2 daemon needs the Nix glibc loader path.
        LD_LIBRARY_PATH = "${pkgs.lib.makeLibraryPath [ pkgs.zlib pkgs.ncurses5 ]}";
      };
    };
}
