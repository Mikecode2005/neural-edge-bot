export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_decisions: {
        Row: {
          candles_snapshot: Json | null
          confidence: number
          contract_id: string | null
          created_at: string
          direction: string
          duration: number | null
          duration_unit: string | null
          executed: boolean
          fvg_zones: Json | null
          id: string
          model: string | null
          ob_zones: Json | null
          prompt_hash: string | null
          reasoning: string | null
          recalled_memory: Json | null
          stake: number | null
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          timeframe: string
          user_id: string
        }
        Insert: {
          candles_snapshot?: Json | null
          confidence: number
          contract_id?: string | null
          created_at?: string
          direction: string
          duration?: number | null
          duration_unit?: string | null
          executed?: boolean
          fvg_zones?: Json | null
          id?: string
          model?: string | null
          ob_zones?: Json | null
          prompt_hash?: string | null
          reasoning?: string | null
          recalled_memory?: Json | null
          stake?: number | null
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          timeframe: string
          user_id: string
        }
        Update: {
          candles_snapshot?: Json | null
          confidence?: number
          contract_id?: string | null
          created_at?: string
          direction?: string
          duration?: number | null
          duration_unit?: string | null
          executed?: boolean
          fvg_zones?: Json | null
          id?: string
          model?: string | null
          ob_zones?: Json | null
          prompt_hash?: string | null
          reasoning?: string | null
          recalled_memory?: Json | null
          stake?: number | null
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          timeframe?: string
          user_id?: string
        }
        Relationships: []
      }
      api_connections: {
        Row: {
          active: boolean
          created_at: string
          encrypted_token: string
          id: string
          label: string | null
          meta: Json | null
          provider: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          encrypted_token: string
          id?: string
          label?: string | null
          meta?: Json | null
          provider: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          encrypted_token?: string
          id?: string
          label?: string | null
          meta?: Json | null
          provider?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          entity: string | null
          entity_id: string | null
          id: string
          ip: string | null
          meta: Json | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          ip?: string | null
          meta?: Json | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          ip?: string | null
          meta?: Json | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      backtest_runs: {
        Row: {
          created_at: string
          end_epoch: number
          equity_curve: Json
          error: string | null
          final_balance: number | null
          final_pnl: number | null
          id: string
          params: Json
          start_epoch: number
          starting_balance: number
          status: string
          symbol: string
          timeframe: string
          trades: Json
          trades_count: number
          updated_at: string
          user_id: string
          win_rate: number | null
        }
        Insert: {
          created_at?: string
          end_epoch: number
          equity_curve?: Json
          error?: string | null
          final_balance?: number | null
          final_pnl?: number | null
          id?: string
          params?: Json
          start_epoch: number
          starting_balance?: number
          status?: string
          symbol: string
          timeframe?: string
          trades?: Json
          trades_count?: number
          updated_at?: string
          user_id: string
          win_rate?: number | null
        }
        Update: {
          created_at?: string
          end_epoch?: number
          equity_curve?: Json
          error?: string | null
          final_balance?: number | null
          final_pnl?: number | null
          id?: string
          params?: Json
          start_epoch?: number
          starting_balance?: number
          status?: string
          symbol?: string
          timeframe?: string
          trades?: Json
          trades_count?: number
          updated_at?: string
          user_id?: string
          win_rate?: number | null
        }
        Relationships: []
      }
      bot_runs: {
        Row: {
          account_loginid: string | null
          account_type: string
          id: string
          interval_seconds: number
          last_error: string | null
          last_tick_at: string | null
          market_mode: string
          max_stake_per_trade: number
          min_confidence: number
          mode: string
          started_at: string
          status: string
          stopped_at: string | null
          symbol: string
          timeframe: string
          total_pnl: number
          total_trades: number
          user_id: string
          account_balance: number
        }
        Insert: {
          account_loginid?: string | null
          account_type: string
          id?: string
          interval_seconds?: number
          last_error?: string | null
          last_tick_at?: string | null
          market_mode?: string
          max_stake_per_trade?: number
          min_confidence?: number
          mode: string
          started_at?: string
          status?: string
          stopped_at?: string | null
          symbol: string
          timeframe?: string
          total_pnl?: number
          total_trades?: number
          user_id: string
          account_balance?: number
        }
        Update: {
          account_loginid?: string | null
          account_type?: string
          id?: string
          interval_seconds?: number
          last_error?: string | null
          last_tick_at?: string | null
          market_mode?: string
          max_stake_per_trade?: number
          min_confidence?: number
          mode?: string
          started_at?: string
          status?: string
          stopped_at?: string | null
          symbol?: string
          timeframe?: string
          total_pnl?: number
          total_trades?: number
          user_id?: string
          account_balance?: number
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          created_at: string
          id: string
          parts: Json
          role: string
          thread_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          parts?: Json
          role: string
          thread_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          parts?: Json
          role?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_threads: {
        Row: {
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      deriv_connections: {
        Row: {
          access_token_encrypted: string
          account_type: string
          balance: number | null
          created_at: string
          currency: string | null
          expires_at: string | null
          id: string
          is_active: boolean
          loginid: string
          refresh_token_encrypted: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_encrypted: string
          account_type: string
          balance?: number | null
          created_at?: string
          currency?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          loginid: string
          refresh_token_encrypted?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token_encrypted?: string
          account_type?: string
          balance?: number | null
          created_at?: string
          currency?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          loginid?: string
          refresh_token_encrypted?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      feedback: {
        Row: {
          comment: string | null
          created_at: string
          id: string
          prediction_id: string | null
          rating: number | null
          user_id: string | null
        }
        Insert: {
          comment?: string | null
          created_at?: string
          id?: string
          prediction_id?: string | null
          rating?: number | null
          user_id?: string | null
        }
        Update: {
          comment?: string | null
          created_at?: string
          id?: string
          prediction_id?: string | null
          rating?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feedback_prediction_id_fkey"
            columns: ["prediction_id"]
            isOneToOne: false
            referencedRelation: "predictions"
            referencedColumns: ["id"]
          },
        ]
      }
      learning_memory: {
        Row: {
          context: Json
          created_at: string
          id: string
          outcome: string
          pattern: string
          pnl: number | null
          symbol: string
          validated: boolean
        }
        Insert: {
          context: Json
          created_at?: string
          id?: string
          outcome: string
          pattern: string
          pnl?: number | null
          symbol: string
          validated?: boolean
        }
        Update: {
          context?: Json
          created_at?: string
          id?: string
          outcome?: string
          pattern?: string
          pnl?: number | null
          symbol?: string
          validated?: boolean
        }
        Relationships: []
      }
      live_signals: {
        Row: {
          confidence: number
          created_at: string
          decision: string
          fvg_zone: Json | null
          id: string
          ob_zone: Json | null
          price: number
          reasoning: string | null
          symbol: string
        }
        Insert: {
          confidence: number
          created_at?: string
          decision: string
          fvg_zone?: Json | null
          id?: string
          ob_zone?: Json | null
          price: number
          reasoning?: string | null
          symbol: string
        }
        Update: {
          confidence?: number
          created_at?: string
          decision?: string
          fvg_zone?: Json | null
          id?: string
          ob_zone?: Json | null
          price?: number
          reasoning?: string | null
          symbol?: string
        }
        Relationships: []
      }
      logs: {
        Row: {
          created_at: string
          id: string
          level: string
          message: string
          meta: Json | null
          source: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          level?: string
          message: string
          meta?: Json | null
          source?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          level?: string
          message?: string
          meta?: Json | null
          source?: string | null
        }
        Relationships: []
      }
      model_versions: {
        Row: {
          artifact_uri: string | null
          created_at: string
          id: string
          is_production: boolean
          metrics: Json | null
          name: string
          notes: string | null
          version: string
        }
        Insert: {
          artifact_uri?: string | null
          created_at?: string
          id?: string
          is_production?: boolean
          metrics?: Json | null
          name: string
          notes?: string | null
          version: string
        }
        Update: {
          artifact_uri?: string | null
          created_at?: string
          id?: string
          is_production?: boolean
          metrics?: Json | null
          name?: string
          notes?: string | null
          version?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          kind: string
          payload: Json | null
          read: boolean
          title: string
          user_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          kind: string
          payload?: Json | null
          read?: boolean
          title: string
          user_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          payload?: Json | null
          read?: boolean
          title?: string
          user_id?: string | null
        }
        Relationships: []
      }
      performance_metrics: {
        Row: {
          computed_at: string
          id: string
          losing_trades: number | null
          max_drawdown: number | null
          mode: string
          period: string
          prediction_accuracy: number | null
          profit_factor: number | null
          sharpe: number | null
          total_pnl: number | null
          total_trades: number | null
          user_id: string | null
          win_rate: number | null
          winning_trades: number | null
        }
        Insert: {
          computed_at?: string
          id?: string
          losing_trades?: number | null
          max_drawdown?: number | null
          mode: string
          period: string
          prediction_accuracy?: number | null
          profit_factor?: number | null
          sharpe?: number | null
          total_pnl?: number | null
          total_trades?: number | null
          user_id?: string | null
          win_rate?: number | null
          winning_trades?: number | null
        }
        Update: {
          computed_at?: string
          id?: string
          losing_trades?: number | null
          max_drawdown?: number | null
          mode?: string
          period?: string
          prediction_accuracy?: number | null
          profit_factor?: number | null
          sharpe?: number | null
          total_pnl?: number | null
          total_trades?: number | null
          user_id?: string | null
          win_rate?: number | null
          winning_trades?: number | null
        }
        Relationships: []
      }
      portfolio: {
        Row: {
          balance: number
          created_at: string
          equity: number
          id: string
          mode: string
          open_positions: number
          realized_pnl: number
          unrealized_pnl: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          balance?: number
          created_at?: string
          equity?: number
          id?: string
          mode: string
          open_positions?: number
          realized_pnl?: number
          unrealized_pnl?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          balance?: number
          created_at?: string
          equity?: number
          id?: string
          mode?: string
          open_positions?: number
          realized_pnl?: number
          unrealized_pnl?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      prediction_results: {
        Row: {
          actual_outcome: string | null
          actual_price_at_resolve: number | null
          id: string
          pnl: number | null
          prediction_id: string
          resolved_at: string
          was_correct: boolean | null
        }
        Insert: {
          actual_outcome?: string | null
          actual_price_at_resolve?: number | null
          id?: string
          pnl?: number | null
          prediction_id: string
          resolved_at?: string
          was_correct?: boolean | null
        }
        Update: {
          actual_outcome?: string | null
          actual_price_at_resolve?: number | null
          id?: string
          pnl?: number | null
          prediction_id?: string
          resolved_at?: string
          was_correct?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_results_prediction_id_fkey"
            columns: ["prediction_id"]
            isOneToOne: false
            referencedRelation: "predictions"
            referencedColumns: ["id"]
          },
        ]
      }
      predictions: {
        Row: {
          confidence: number
          created_at: string
          decision: string
          id: string
          indicators: Json | null
          market_state: Json | null
          model_version: string | null
          reasoning: string | null
          risk_score: number | null
          strategy_id: string | null
          success_probability: number | null
          suggested_entry: number | null
          suggested_size: number | null
          suggested_sl: number | null
          suggested_tp: number | null
          symbol: string
          timeframe: string
          trade_plan: Json | null
          user_id: string | null
        }
        Insert: {
          confidence: number
          created_at?: string
          decision: string
          id?: string
          indicators?: Json | null
          market_state?: Json | null
          model_version?: string | null
          reasoning?: string | null
          risk_score?: number | null
          strategy_id?: string | null
          success_probability?: number | null
          suggested_entry?: number | null
          suggested_size?: number | null
          suggested_sl?: number | null
          suggested_tp?: number | null
          symbol: string
          timeframe?: string
          trade_plan?: Json | null
          user_id?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          decision?: string
          id?: string
          indicators?: Json | null
          market_state?: Json | null
          model_version?: string | null
          reasoning?: string | null
          risk_score?: number | null
          strategy_id?: string | null
          success_probability?: number | null
          suggested_entry?: number | null
          suggested_size?: number | null
          suggested_sl?: number | null
          suggested_tp?: number | null
          symbol?: string
          timeframe?: string
          trade_plan?: Json | null
          user_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          role: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          role?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          role?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      settings: {
        Row: {
          account_mode: string
          auto_trade: boolean
          confidence_stake_curve: Json
          confidence_threshold: number
          created_at: string
          custom_doctrine: string | null
          dark_mode: boolean
          default_interval_seconds: number
          default_symbol: string
          default_timeframe: string
          id: string
          language: string
          max_daily_loss: number
          max_open_trades: number
          max_stake: number
          max_trades_per_day: number
          min_confidence: number
          notifications_enabled: boolean
          preferred_indicators: Json
          risk_percent: number
          theme: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          account_mode?: string
          auto_trade?: boolean
          confidence_stake_curve?: Json
          confidence_threshold?: number
          created_at?: string
          custom_doctrine?: string | null
          dark_mode?: boolean
          default_interval_seconds?: number
          default_symbol?: string
          default_timeframe?: string
          id?: string
          language?: string
          max_daily_loss?: number
          max_open_trades?: number
          max_stake?: number
          max_trades_per_day?: number
          min_confidence?: number
          notifications_enabled?: boolean
          preferred_indicators?: Json
          risk_percent?: number
          theme?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          account_mode?: string
          auto_trade?: boolean
          confidence_stake_curve?: Json
          confidence_threshold?: number
          created_at?: string
          custom_doctrine?: string | null
          dark_mode?: boolean
          default_interval_seconds?: number
          default_symbol?: string
          default_timeframe?: string
          id?: string
          language?: string
          max_daily_loss?: number
          max_open_trades?: number
          max_stake?: number
          max_trades_per_day?: number
          min_confidence?: number
          notifications_enabled?: boolean
          preferred_indicators?: Json
          risk_percent?: number
          theme?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      strategies: {
        Row: {
          config: Json
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          kind: string
          name: string
          symbols: Json
          timeframe: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          config?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          kind?: string
          name: string
          symbols?: Json
          timeframe?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          config?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          kind?: string
          name?: string
          symbols?: Json
          timeframe?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      strategy_memory: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          lesson: string
          outcome: string | null
          pinned: boolean
          pnl: number | null
          setup_type: string | null
          symbol: string | null
          tags: string[] | null
          timeframe: string | null
          times_recalled: number
          updated_at: string
          usefulness_score: number
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          lesson: string
          outcome?: string | null
          pinned?: boolean
          pnl?: number | null
          setup_type?: string | null
          symbol?: string | null
          tags?: string[] | null
          timeframe?: string | null
          times_recalled?: number
          updated_at?: string
          usefulness_score?: number
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          lesson?: string
          outcome?: string | null
          pinned?: boolean
          pnl?: number | null
          setup_type?: string | null
          symbol?: string | null
          tags?: string[] | null
          timeframe?: string | null
          times_recalled?: number
          updated_at?: string
          usefulness_score?: number
          user_id?: string
        }
        Relationships: []
      }
      trade_history: {
        Row: {
          ai_decision_id: string | null
          closed_at: string | null
          created_at: string
          deriv_contract_id: string | null
          entry_price: number
          exit_price: number | null
          id: string
          mode: string
          opened_at: string
          pnl: number | null
          prediction_id: string | null
          reason_closed: string | null
          reason_opened: string | null
          side: string
          size: number
          status: string
          stop_loss: number | null
          strategy_id: string | null
          symbol: string
          take_profit: number | null
          user_id: string | null
        }
        Insert: {
          ai_decision_id?: string | null
          closed_at?: string | null
          created_at?: string
          deriv_contract_id?: string | null
          entry_price: number
          exit_price?: number | null
          id?: string
          mode: string
          opened_at?: string
          pnl?: number | null
          prediction_id?: string | null
          reason_closed?: string | null
          reason_opened?: string | null
          side: string
          size: number
          status?: string
          stop_loss?: number | null
          strategy_id?: string | null
          symbol: string
          take_profit?: number | null
          user_id?: string | null
        }
        Update: {
          ai_decision_id?: string | null
          closed_at?: string | null
          created_at?: string
          deriv_contract_id?: string | null
          entry_price?: number
          exit_price?: number | null
          id?: string
          mode?: string
          opened_at?: string
          pnl?: number | null
          prediction_id?: string | null
          reason_closed?: string | null
          reason_opened?: string | null
          side?: string
          size?: number
          status?: string
          stop_loss?: number | null
          strategy_id?: string | null
          symbol?: string
          take_profit?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trade_history_ai_decision_id_fkey"
            columns: ["ai_decision_id"]
            isOneToOne: false
            referencedRelation: "ai_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_history_prediction_id_fkey"
            columns: ["prediction_id"]
            isOneToOne: false
            referencedRelation: "predictions"
            referencedColumns: ["id"]
          },
        ]
      }
      watchlists: {
        Row: {
          created_at: string
          id: string
          name: string
          symbols: Json
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string
          symbols?: Json
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          symbols?: Json
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      live_trade_history: {
        Row: {
          closed_at: string | null
          created_at: string | null
          deriv_contract_id: string | null
          entry_price: number | null
          exit_price: number | null
          id: string | null
          mode: string | null
          opened_at: string | null
          pnl: number | null
          prediction_id: string | null
          reason_closed: string | null
          reason_opened: string | null
          side: string | null
          size: number | null
          status: string | null
          stop_loss: number | null
          strategy_id: string | null
          symbol: string | null
          take_profit: number | null
          user_id: string | null
        }
        Insert: {
          closed_at?: string | null
          created_at?: string | null
          deriv_contract_id?: string | null
          entry_price?: number | null
          exit_price?: number | null
          id?: string | null
          mode?: string | null
          opened_at?: string | null
          pnl?: number | null
          prediction_id?: string | null
          reason_closed?: string | null
          reason_opened?: string | null
          side?: string | null
          size?: number | null
          status?: string | null
          stop_loss?: number | null
          strategy_id?: string | null
          symbol?: string | null
          take_profit?: number | null
          user_id?: string | null
        }
        Update: {
          closed_at?: string | null
          created_at?: string | null
          deriv_contract_id?: string | null
          entry_price?: number | null
          exit_price?: number | null
          id?: string | null
          mode?: string | null
          opened_at?: string | null
          pnl?: number | null
          prediction_id?: string | null
          reason_closed?: string | null
          reason_opened?: string | null
          side?: string | null
          size?: number | null
          status?: string | null
          stop_loss?: number | null
          strategy_id?: string | null
          symbol?: string | null
          take_profit?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trade_history_prediction_id_fkey"
            columns: ["prediction_id"]
            isOneToOne: false
            referencedRelation: "predictions"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_trade_history: {
        Row: {
          closed_at: string | null
          created_at: string | null
          deriv_contract_id: string | null
          entry_price: number | null
          exit_price: number | null
          id: string | null
          mode: string | null
          opened_at: string | null
          pnl: number | null
          prediction_id: string | null
          reason_closed: string | null
          reason_opened: string | null
          side: string | null
          size: number | null
          status: string | null
          stop_loss: number | null
          strategy_id: string | null
          symbol: string | null
          take_profit: number | null
          user_id: string | null
        }
        Insert: {
          closed_at?: string | null
          created_at?: string | null
          deriv_contract_id?: string | null
          entry_price?: number | null
          exit_price?: number | null
          id?: string | null
          mode?: string | null
          opened_at?: string | null
          pnl?: number | null
          prediction_id?: string | null
          reason_closed?: string | null
          reason_opened?: string | null
          side?: string | null
          size?: number | null
          status?: string | null
          stop_loss?: number | null
          strategy_id?: string | null
          symbol?: string | null
          take_profit?: number | null
          user_id?: string | null
        }
        Update: {
          closed_at?: string | null
          created_at?: string | null
          deriv_contract_id?: string | null
          entry_price?: number | null
          exit_price?: number | null
          id?: string | null
          mode?: string | null
          opened_at?: string | null
          pnl?: number | null
          prediction_id?: string | null
          reason_closed?: string | null
          reason_opened?: string | null
          side?: string | null
          size?: number | null
          status?: string | null
          stop_loss?: number | null
          strategy_id?: string | null
          symbol?: string | null
          take_profit?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trade_history_prediction_id_fkey"
            columns: ["prediction_id"]
            isOneToOne: false
            referencedRelation: "predictions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
