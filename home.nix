{ config, lib, pkgs, user, ... }:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  githubSshKey = "${config.home.homeDirectory}/.ssh/id_ed25519_github";
  githubUsername = "vyshakg";
  githubEmail = "vyshak.g.gowda@gmail.com";
  nvmScript = "/opt/homebrew/opt/nvm/nvm.sh";
  uvScript = "/opt/homebrew/opt/uv/bin/uv";
in

{
  home.username = user;
  home.homeDirectory = "/Users/${user}";
  home.stateVersion = "24.11";
  home.packages = with pkgs; [
    # cli i use constantly
    ripgrep   # fast search
    fd        # fast find
    fzf       # fuzzy finder
    jq        # json on the command line
    lazygit
    neovim
    # the font everything renders in
    nerd-fonts.hack
  ];
  fonts.fontconfig.enable = true;
  home.sessionVariables.EDITOR = "nvim";
  home.sessionPath = [ "${config.home.homeDirectory}/.local/bin" ];

  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;      # ghost text from history
    syntaxHighlighting.enable = true;  # commands turn green when valid
    initContent = ''
      bindkey '^f' autosuggest-accept
      export NVM_DIR="$HOME/.nvm"
      [ -s "${nvmScript}" ] && \. "${nvmScript}"
    '';
    shellAliases = {
      ".." = "cd ..";
      add = "git add .";
      push = "git push";
      pull = "git pull";
      m = "git switch main";
      cc = "claude --dangerously-skip-permissions";
    };
  };
  home.activation.generateGithubSshKey = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    if [ ! -f "${githubSshKey}" ]; then
      $DRY_RUN_CMD mkdir -p "${config.home.homeDirectory}/.ssh"
      $DRY_RUN_CMD chmod 700 "${config.home.homeDirectory}/.ssh"
      $DRY_RUN_CMD ${pkgs.openssh}/bin/ssh-keygen -t ed25519 -f "${githubSshKey}" -N "" -C "${githubUsername}@github"
      echo "Generated a new GitHub SSH key. Add this public key to https://github.com/settings/keys:"
      $DRY_RUN_CMD cat "${githubSshKey}.pub"
    fi
  '';

  home.activation.installNodeStable = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    if [ -s "${nvmScript}" ]; then
      (
        export PATH="/usr/bin:/usr/sbin:/bin:$PATH"
        export NVM_DIR="${config.home.homeDirectory}/.nvm"
        $DRY_RUN_CMD mkdir -p "$NVM_DIR"
        . "${nvmScript}"
        $DRY_RUN_CMD nvm install stable
        $DRY_RUN_CMD nvm alias default stable
      )
    else
      echo "nvm not found at ${nvmScript} yet - rerun ./rebuild.sh once Homebrew has installed it to install Node stable."
    fi
  '';

  home.activation.installPythonStable = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    if [ -x "${uvScript}" ]; then
      (
        export PATH="/usr/bin:/usr/sbin:/bin:$PATH"
        $DRY_RUN_CMD "${uvScript}" python install 3.12 --default --preview-features python-install-default
      )
    else
      echo "uv not found at ${uvScript} yet - rerun ./rebuild.sh once Homebrew has installed it to install Python."
    fi
  '';

  programs.git = {
    enable = true;
    settings.user = {
      name = githubUsername;
      email = githubEmail;
    };
  };

  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;
    settings."github.com" = {
      HostName = "github.com";
      User = "git";
      IdentityFile = githubSshKey;
      IdentitiesOnly = true;
      UseKeychain = true;
      AddKeysToAgent = "yes";
    };
  };

  programs.starship = {
    enable = true;
    settings = {
      add_newline = false;
      format = "$directory$git_branch$git_status$cmd_duration$line_break$character";
      character = {
        success_symbol = "[❯](purple)";
        error_symbol = "[❯](red)";
      };
      cmd_duration.format = "[$duration]($style) ";
    };
  };

  # Edit-in-place: the real file stays in my repo, ~/.config just points at it.
  home.file.".config/wezterm".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/wezterm";
  home.file.".config/nvim".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/nvim";
  home.file.".config/herdr".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/herdr";
  home.file.".claude/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/settings.json";
  home.file.".claude/statusline.sh".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/statusline.sh";

}
