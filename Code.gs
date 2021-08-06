

class _SwopCx {

  /**
   * make a digest to use as contrstuctor name + content addressable cache key
   */
  static digest(...args) {
    // conver args to an array and digest them
    const t = args.concat(['_SwopCx']).map(d => {
      return (Object(d) === d) ? JSON.stringify(d) : (typeof d === typeof undefined ? 'undefined' : d.toString());
    }).join("-")
    const s = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, t, Utilities.Charset.UTF_8)
    return Utilities.base64EncodeWebSafe(s)
  };

  /**
   * zip some content - for this use case - it's for cache, we're expecting string input/output
   * @param {string} crushThis the thing to be crushed
   * @raturns {string}  the zipped contents as base64
   */
  static crush (crushThis) {
    return Utilities.base64Encode(Utilities.zip([Utilities.newBlob(crushThis)]).getBytes());
  }

  /**
   * unzip some content - for this use case - it's for cache, we're expecting string input/output
   * @param {string} crushed the thing to be uncrushed - this will be base64 string
   * @raturns {string}  the unzipped and decoded contents
   */
  static uncrush (crushed) {
    return Utilities.unzip(Utilities.newBlob(Utilities.base64Decode(crushed), 'application/zip'))[0].getDataAsString();
  }

  /**
   * @param {options}
   * @param {function} options.fetcher the fetcher function from apps script- passed over to keep lib dependency free
   * @param {string} options.apiKey the apiKey
   * @param {string} [options.defaultBase ="EUR"] the default base currency - this doesn't work with the free version
   * @param {boolean} [options.freeTier = true] whether the apiKey is for the limited free tier
   * @param {cache} [options.cache = null] the apps script cache service to use
   * @param {number} [options.cacheSeconds = 3600] the lifetime for cache
   */
  constructor({ fetcher, apiKey, defaultBase = "EUR", freeTier = true, cache = null, cacheSeconds = 60 * 60 }) {

    if (!apiKey) throw new Error('apiKey property not provided - goto fixer.io to get one and pass to constructor')
    if (!fetcher) throw new Error('fetcher property not provided- pass urlfetchapp.fetch to constructor')

    // these options are standard
    const standardOptions = {
      method: 'POST',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: {
        Authorization: `ApiKey ${apiKey}`
      }
    }

    // and the GraphQL url is standard
    const url = 'https://swop.cx/graphql'


    // using these handlers
    // the get and set functions are enhanced to make a digest from a set of keys
    // so the arguments are not in the normal order
    // also decorates the data with timestamps etc and compresses/decompresses it
    const cacheGetHandler = {
      apply(targetFunction, thisArg, args) {
        // call the cache get function and make the keys
        const digest = _SwopCx.digest(args)
        const result = targetFunction.apply(thisArg, [digest])
        if (result) {
          const uncrushed = _SwopCx.uncrush(result)
          const r = JSON.parse(uncrushed)
          r.fromCache = true;
          return r
        }
        return null
      }
    }

    const cacheSetHandler = {
      apply(targetFunction, thisArg, args) {
        const [data, expiry, ...keys] = args
        const digest = _SwopCx.digest(keys)
        const pack = {
          timestamp: new Date().getTime(),
          fromCache: false,
          digest,
          data
        }
        targetFunction.apply(thisArg, [digest, _SwopCx.crush(JSON.stringify(pack)), expiry])
        return pack
      }
    }

    const cacheHandler = {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property === 'get') {
          return new Proxy(value, cacheGetHandler)
        } else if (property = 'set') {
          return new Proxy(value, cacheSetHandler)
        }
        // just return the regular object
        return value
      }
    }

    // use the modifed cache object instead
    const proxyCache = cache && new Proxy(cache, cacheHandler)

    // this is the proxy will do we'll do when asked to fetch something
    const fetcherHandler = {
      apply(targetFunction, thisArg, args) {
        const [payloadObject, params] = args
        if (args.length !== 2 || typeof payloadObject !== 'object' || !payloadObject) throw new Error('invalid fetch arguments')
        const options = {
          ...standardOptions,
          payload: JSON.stringify(payloadObject)
        }
        const fetchArgs = [url, options]
       
        // first check if it's in cache
        let cached = !params.noCache && proxyCache && proxyCache.get(fetchArgs)
        let error = null
        // if it's not then we have to fetch it, using the proxy fetcher
        if (!cached) {
          // just add the payload to the normal results
          const response = targetFunction.apply(thisArg, fetchArgs)
          const text = response.getContentText()
          const data = text ? JSON.parse(text) : null
          if (response.getResponseCode() !== 200) {
            error = text
          }
          cached = error ? null : proxyCache.put(data, cacheSeconds, fetchArgs)
        }
        // standardize a response for error handling
        const d = cached && cached.data && cached.data.data && cached.data.data
        const gqlData = d && d[Object.keys(d)[0]]
        return {
          data: gqlData,
          digest: cached && cached.digest,
          timestamp: cached && cached.timestamp,
          error: error || (!gqlData && cached),
          fromCache: cached && cached.fromCache
        }
      }
    }


    // the idea here is add some functionality that's specific to this this class to the fetcher
    this.fetcher = new Proxy(fetcher, fetcherHandler)
    this.defaultBase = defaultBase
    this.freeTier = freeTier

  }


  /**
   * @param {options}
   * @param {function} options.symbols the comma separated list of currencies to consider
   * @param {string} [options.base ="EUR"] the default base currency - this doesn't work with the free version
   * @param {boolean} [options.noCache = false] whether to skip caching (if its enabled in the first place)
   * @param {boolean} [options.meta = false] whether to include the metadata about the rate
   */
  latest(params) {

    return this.fetcher({
      query: gql.queries[params.meta ? 'latestMeta' : 'latest'],
      variables: {
        quoteCurrencies: params.symbols.split(","),
        baseCurrency: this.freeTier ? null : params.base || this.defaultBase
      }
    }, params)

  }

  /** 
   * @param {options}
   * @param {function} options.symbols the comma separated list of currencies to consider
   * @param {string} [options.base ="EUR"] the default base currency - this doesn't work with the free version
   * @param {boolean} [options.noCache = false] whether to skip caching (if its enabled in the first place)
   * @param {boolean} [options.meta = false] whether to include the metadata about the rate
   * @param {boolean} [options.startDate = false] whether to include the metadata about the rate
   */
  onThisDay(params) {
    if (!params.startDate) throw new Error(`onThisDay needs a startDate parameter in this format YYYY-MM-DD`)

    const result = this.fetcher({
      query: gql.queries[params.meta ? 'historicalMeta' : 'historical'],
      variables: {
        quoteCurrencies: params.symbols.split(","),
        baseCurrency: this.freeTier ? null : params.base || this.defaultBase,
        date: params.startDate
      }
    }, params)


    result.data.forEach(f => f.historical = true)
    return result

  }


  /** 
   * @param {options}
   * @param {function} options.symbols the comma separated list of currencies to consider
   * @param {boolean} [options.noCache = false] whether to skip caching (if its enabled in the first place)
   */
  currencies(params) {
    return this.fetcher({
      query: gql.queries.currencies,
      variables: {
        currencyCodes: params.symbols.split(",")
      }
    }, params)
  }

  /**
   * do a conversion without using the api as its not available in the free tier
   * @param {object} swopCxResult an api response parsed as recevied by onThisDay() or latest()
   * @param {object} options
   * @param {string} options.from the from currency
   * @param {string} options.to the to currency
   * @param {number} [options.amount=1] the amount to convert
   * @returns {object} result
   */
  hackConvert(swopCxResult, { from, to, amount = 1 }) {
    // check that the result is a valid one
    if (!Array.isArray(swopCxResult)) throw new Error('input swopCxResult should be an array')
    // and that it contains both from and to rates

    const rateFrom = swopCxResult.find(f => from === f.quoteCurrency)
    const rateTo = swopCxResult.find(f => to === f.quoteCurrency)
    if (!rateFrom) throw new Error('from currency not found in swopCxResult')
    if (!rateTo) throw new Error('to currency not found in swopCxResult')
    if (rateFrom.baseCurrency !== rateTo.baseCurrency) throw new Error('base currencies mst match for conversion to work')
    const rate = rateTo.quote / rateFrom.quote
    const result = rate * amount
    const { historical, date } = rateFrom

    return {
      rate,
      historical: historical || false,
      date,
      result,
      to,
      from,
      amount
    }

  }

}
const gql = {
  get frags() {
    return {
      fragCurrencyType:
        `fragment fragCurrencyType on CurrencyType {
          code
          name
          numericCode
          decimalDigits
          active
        }`,

      fragRate:
        `fragment fragRate on Rate {
          date
          baseCurrency
          quoteCurrency
          quote
        }`,

      fragMeta:
        `fragment fragMeta on Rate {
          meta {
            sourceShortNames
            sourceNames
            sourceIds
            sources {
              id
              shortName
              name
            }
            rateType
            calculated
            calculationShortDescription
            calculationDescription
            calculation {
              pathRate
              weight
              sourceRates {
                sourceId
                date
                baseCurrency
                quoteCurrency
                quote
                flipped
                fetched
                source {
                  id
                  shortName
                  name
                }
              }
            }
          }
        }`
    }
  },

  get queries() {
    return {
      currencies:
        `query ($currencyCodes:[String!]){
          currencies(currencyCodes: $currencyCodes) {
		        ...fragCurrencyType
          }
        }
      ${this.frags.fragCurrencyType}`,

      latest:
        `query ($baseCurrency: String, $quoteCurrencies:[String!]) {
          latest (baseCurrency: $baseCurrency, quoteCurrencies: $quoteCurrencies) {
            ...fragRate
          }
        }
      ${this.frags.fragRate}`,

      latestMeta:
        `query ( $baseCurrency: String, $quoteCurrencies:[String!]) {
          latest (baseCurrency: $baseCurrency, quoteCurrencies: $quoteCurrencies) {
            ...fragRate
            ...fragMeta
          }
        }
      }
      ${this.frags.fragRate}
      ${this.frags.fragMeta},
      `,
      historical:
        `query ($date: Date!, $baseCurrency: String, $quoteCurrencies:[String!]) {
          historical (date:$date, baseCurrency: $baseCurrency, quoteCurrencies: $quoteCurrencies) {
            ...fragRate
          }
        }
      ${this.frags.fragRate}`,

      historicalMeta:
        `query ($date: Date!, $baseCurrency: String, $quoteCurrencies:[String!]) {
          historical (date:$date, baseCurrency: $baseCurrency, quoteCurrencies: $quoteCurrencies) {
            ...fragRate
            ...fragMeta
          }
        }
      }
      ${this.frags.fragRate}
      ${this.frags.fragMeta}
      `
    }
  }
}

var Fx = (options) => new _SwopCx(options)
