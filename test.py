import MetaTrader5 as mt5

if not mt5.initialize():
    print("Initialize failed:", mt5.last_error())
    quit()

symbol = "Volatility 10 Index"

# Make sure the symbol is available
if not mt5.symbol_select(symbol, True):
    print("Could not select symbol")
    mt5.shutdown()
    quit()

info = mt5.symbol_info(symbol)
tick = mt5.symbol_info_tick(symbol)

volume = 0.50
order_type = mt5.ORDER_TYPE_BUY
price = tick.ask

request = {
    "action": mt5.TRADE_ACTION_DEAL,
    "symbol": symbol,
    "volume": volume,
    "type": order_type,
    "price": price,
    "deviation": 20,
    "magic": 123456,
    "comment": "Legendary AI Test",
    "type_time": mt5.ORDER_TIME_GTC,

    # We already discovered Deriv requires FOK
    "type_filling": mt5.ORDER_FILLING_FOK,
}

print("REQUEST:")
print(request)

print("\nORDER CHECK:")
check = mt5.order_check(request)
print(check)

print("\nORDER SEND:")
result = mt5.order_send(request)
print(result)

if result:
    print("\nRetcode:", result.retcode)
    print("Comment:", result.comment)

mt5.shutdown()