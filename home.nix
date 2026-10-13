{ config, lib, pkgs, user, ... }:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  githubSshKey = "${config.home.homeDirectory}/.ssh/id_ed25519_github";
  digitalOceanSshKey = "${config.home.homeDirectory}/.ssh/id_ed25519_do";
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
  home.sessionVariables = {
    EDITOR = "nvim";
    NODE_EXTRA_CA_CERTS = "/etc/ssl/certs/ca-certificates.crt";
  };
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

  home.activation.generateDigitalOceanSshKey = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    if [ ! -f "${digitalOceanSshKey}" ]; then
      $DRY_RUN_CMD mkdir -p "${config.home.homeDirectory}/.ssh"
      $DRY_RUN_CMD chmod 700 "${config.home.homeDirectory}/.ssh"
      $DRY_RUN_CMD ${pkgs.openssh}/bin/ssh-keygen -t ed25519 -f "${digitalOceanSshKey}" -N "" -C "${githubUsername}@digitalocean"
      echo "Generated a new DigitalOcean SSH key. Add this public key at https://cloud.digitalocean.com/account/security:"
      $DRY_RUN_CMD cat "${digitalOceanSshKey}.pub"
    fi
  '';

  home.activation.installNodeStable =lib.hm.dag.entryAfter [ "writeBoundary" ] ''
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

  home.activation.installTavilyCli = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    if [ -x "${uvScript}" ]; then
      (
        export PATH="/usr/bin:/usr/sbin:/bin:$PATH"
        $DRY_RUN_CMD "${uvScript}" tool install tavily-cli
      )
    else
      echo "uv not found at ${uvScript} yet - rerun ./rebuild.sh once Homebrew has installed it to install the Tavily CLI."
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
  home.file.".claude/hooks/herdr-agent-state.sh".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/hooks/herdr-agent-state.sh";
  home.file.".claude/hooks/md-log.mjs".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/hooks/md-log.mjs";
  home.file.".claude/commands".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/commands";
  # Per-skill links: ~/.claude/skills also holds app-managed content (synced/)
  home.file.".claude/skills/grill-with-docs".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/skills/grill-with-docs";
  home.file.".claude/skills/grilling".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/skills/grilling";
  home.file.".claude/skills/domain-modeling".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/skills/domain-modeling";
  home.file.".pi/agent/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/settings.json";
  home.file.".pi/agent/extensions".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions";

  home.activation.installPiExtensionDeps = lib.hm.dag.entryAfter [ "installNodeStable" ] ''
    (
      export PATH="/opt/homebrew/bin:/usr/bin:/usr/sbin:/bin:$PATH"
      export NVM_DIR="${config.home.homeDirectory}/.nvm"
      [ -s "${nvmScript}" ] && . "${nvmScript}"
      if command -v npm >/dev/null; then
        for lock in "${dotfiles}"/home/.pi/agent/extensions/*/package-lock.json; do
          dir="$(dirname "$lock")"
          grep -q '"dependencies"' "$dir/package.json" || continue
          if [ ! -d "$dir/node_modules" ] || [ "$lock" -nt "$dir/node_modules" ]; then
            $DRY_RUN_CMD sh -c 'cd "$1" && npm ci --omit=dev --omit=peer --no-audit --no-fund' _ "$dir" \
              || echo "npm ci failed in $dir - rerun ./rebuild.sh"
          fi
        done
        playwright="${dotfiles}/home/.pi/agent/extensions/browser/node_modules/.bin/playwright-core"
        if [ -x "$playwright" ]; then
          $DRY_RUN_CMD "$playwright" install chromium || echo "Chromium install failed - rerun ./rebuild.sh"
        fi
      else
        echo "npm not found yet - rerun ./rebuild.sh once Homebrew has installed node to set up pi extension deps."
      fi
    )
  '';
  home.file.".pi/agent/skills".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/skills";
  home.file.".pi/agent/agents".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/agents";

}
