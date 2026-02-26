# Settings
Output demo.gif
Set FontSize 18
Set Width 1200
Set Height 800
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms

# Hidden cleanup
Hide
Type "agentd stop 2>/dev/null; rm -rf ~/.agentd/agents/todo-scanner/state.db ~/.agentd/agentd.db 2>/dev/null"
Enter
Sleep 3s
Type "clear"
Enter
Sleep 500ms
Show

# Scene 1: Start the daemon
Type "agentd start"
Enter
Sleep 3s

# Scene 2: Check status — show auto-discovered tools
Type "agentd status"
Enter
Sleep 4s

# Scene 3: Show the agent YAML
Type "cat ~/.agentd/agents/todo-scanner/agent.yaml"
Enter
Sleep 5s

# Scene 4: Register the agent
Type "agentd agents add todo-scanner"
Enter
Sleep 3s

# Scene 5: Run it manually
Type "agentd run todo-scanner"
Enter
Sleep 8s

# Scene 6: Check the logs
Type "agentd logs todo-scanner"
Enter
Sleep 5s

# Scene 7: Check costs
Type "agentd costs"
Enter
Sleep 4s

# Scene 8: Stop
Type "agentd stop"
Enter
Sleep 2s