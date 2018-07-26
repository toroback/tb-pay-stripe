/** 
 * @module tb-pay-stripe
 *
 * @description 
 *
 * <p>
 * Module to receive payments using Stripe service. This service is used through module <b>tb-pay</b>
 * <p>
 * 
 * @see [Guía de uso]{@tutorial tb-pay-stripe} para más información.
 * @see [REST API]{@link module:tb-pay/routes} (API externo).
 * @see [Class API]{@link module:tb-pay-stripe.Adapter} (API interno).
 * @see Repositorio en {@link https://github.com/toroback/tb-pay-stripe|GitHub}.
 * </p>
 * 
 */


let stripe = require('stripe');

// https://stripe.com/docs/currencies
// https://stripe.com/docs/currencies#zero-decimal
//  zero-decimal currencies. stripe needs to multiply the amount by the smallest unit, except for these currencies
let zeroDecimalCurrencies = [
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'
];
/**
 * Adaptador del servicio Stripe
 * @memberOf module:tb-pay-stripe
 */
class Adapter {
  /**
   * Crea un adaptador de Stripe
   * @param  {Object} client. Objeto con la informacion para crear el adaptador.
   */
  constructor (_app, client){
    this.app = _app;
    this.log = _app.log.child({module:'pay-stripe'});
    this.client = client;

    this.apiKey = client.options.apiKey;
    this.stripe = stripe( this.apiKey );
  }

  echo ( ) {
    return new Promise((resolve, reject) => {
      this.log.trace('echo');
      resolve({ success: true });
    });
  };

  getBalance ( ) {
    return new Promise( ( resolve, reject ) => {
      this.log.trace('getBalance');
      this.stripe.balance.retrieve( )
        .then( resp => {
          let ret = { data: resp, balance: { } };
          if ( resp.available && resp.available.length ) {
            let available = resp.available[0];
            ret.balance.amount = fromStripeAmount( available.amount, available.currency );
            ret.balance.currency = available.currency.toUpperCase( );
          }
          return ret;
        })
        .then(resolve)
        .catch(reject);
    });
  }

/*
 *  data: { }
 *    payTransaction: db object
 *    token: (optional) stripe.js token for a one-time payment
 *    statementDescription: (optional) description for credit card statement. max. 22 characters
 *    store: Bool: (optional) whether to store this token as a permanent account for this user (from payTransaction.uid)
 *    user: db object user (optional: required if token && store. at least: _id, firstName, lastName, email.login)
 *    payAccount: db object tb-pay-account (optional: required if payTransaction.paid)
 */
  charge ( data ) {
    return new Promise( ( resolve, reject ) => {
      let User = this.app.db.model('users');
      let needsAccount;
      let payAccount;
      let chargeData = { };
      let request = { };
      let ret = { };
      let prom;

      this.log.trace('charge');

      chargeData.amount               = Number.parseFloat( data.payTransaction.amount );
      chargeData.currency             = data.payTransaction.currency;
      chargeData.description          = data.payTransaction.description;
      chargeData.statementDescription = data.statementDescription;
      chargeData.ptid                 = data.payTransaction._id;

      // we still need customer and source. 3 options:
      // A) if payTransaction.paid: account already exists. get customer and source from account
      // B) if token present and !store, it's a one-time transaction. no customer needed
      // C) if token present and store, we need to create an account (previously, create customer if doesn't exist already)

      if ( data.payTransaction.paid ) { // A
        prom = data.payAccount;
      } else if ( data.token && data.store ) {  // B
        prom = ensureAccount( this.stripe, data.user, data.token );  // create the account as requested
      } // C, no account needed

      Promise.resolve( prom )
        .then( account => {
          payAccount = account; // may be undefined (C)
          if ( payAccount ) {
            chargeData.customerId = payAccount.sUserId;
            chargeData.source = payAccount.sAccountId;
          } else {
            chargeData.source = data.token;
          }
          return createCharge( this.stripe, chargeData, request );
        })
        .then( charge => {
          ret.request = request;
          ret.response = charge;
          ret.sTransId = charge.id;
          ret.data = { }; // useful data to keep in transaction
          if ( chargeData.customerId ) ret.data.sUserId = chargeData.customerId;  // just for it not to store as null in db (mixed type)
          ret.data.sAccountId = charge.source ? charge.source.id : undefined;
          resolve ( ret );
        })
        .catch( err => {
          if ( err.raw && err.raw.type ) { // stripe error on api call
            ret.request = request;
            ret.response = err.raw;
            ret.error = err;
          } else {
            ret = err;
          }
          reject ( ret );
        })
    });
  }
}

// creates a new customer. if token is passed, it is attached as a source
// stripe: stripe client instance
// data: { }
//   user: user object from db. uses: firstName, lastName, email, _id.
//   token: (optional) token from stripe.js to asociate a source to this new customer
// request: (optional) (out data) pass an empty object { } to receive back the original request made to the API
// returns: a promise with the reply from customer.create API
function createCustomer ( stripe, data, request ) {
  let req = {
    description: data.user.firstName + ' ' + data.user.lastName,
    email: data.user.email.login,
    source: data.token,
    metadata: {
      uid: data.user._id.toString( )
    }
  };
  assignToEmptyObject( request, req );
  return stripe.customers.create( req );
}

// creates a new customer source, and adds it to the customer
// stripe: stripe client instance
// data: { }
//   customerId: customer id according to stripe, asociated to the user
//   token: token from stripe.js to create a source from, and asociate to the customerId
//   payAccount: (optional) tb.pay-account from db to store _id as metadata
// request: (optional) (out data) pass an empty object { } to receive back the original request made to the API
// returns: a promise with the reply from customer.createSource API
function createCustomerSource ( stripe, data, request ) {
  let req = { source: data.token };
  if ( data.payAccount ) {
    req.metadata = { paid: data.payAccount._id.toString( ) };
  }
  assignToEmptyObject( request, req );
  return stripe.customers.createSource( data.customerId, req );
}

// makes a new charge to a customer source
// stripe: stripe client instance
// data: { }
//   customerId: (optional) customer id according to stripe, asociated to the user.
//             if not passed, it means it's an unlinked charge (user didn't request to save the source)
//   source: either:
//         - token from stripe.js, not directly linked to an existing customerId
//         - existing source, already asociated to customerId
//   amount:  amount to charge
//   currency: ISO currency
//   description: (optional) description for this charge. shown to user in receipt
//   statementDescription: (optional) description for this charge. shown to user in credit card statement. max: 22 characters
//   ptid:  (optional) pay transaction _id from database, to be added to metadata
// request: (optional) (out data) pass an empty object { } to receive back the original request made to the API
// returns: a promise with the reply from charges.create API
function createCharge ( stripe, data, request ) {
  let req = { // request
    amount: toStripeAmount( data.amount, data.currency ),
    currency: data.currency.toLowerCase( ),  // as required by stripe
    customer: data.customerId,  // if any
    source: data.source,
    description: data.description,
    statement_descriptor: data.statementDescription ? data.statementDescription.slice(0, 22) : undefined,
    metadata: {
      ptid: data.ptid.toString( )   // pay transaction _id
    }
  };
  assignToEmptyObject( request, req );
  return stripe.charges.create( req );
}

// creates a stripe account for this user. also creates a stripe customer if it doesn't exist already
// stores in DB new customer and new account
// stripe: stripe client instance
// user: db user object for whom this account is
// token: source token from stripe.js to create the account
// return: tb.payAccount object created
function ensureAccount( stripe, user, token ) {
  return new Promise( ( resolve, reject ) => {
    let PayAccount = App.db.model('tb.pay-accounts');
    let request = { };
    let customerId;
    let payAccount;
    let error;

    // make sure this user doesn't have a customer already created in stripe
    // no customer? create one before creating the new account

    PayAccount.findOne( { 'uid': user._id, 'service': 'stripe', 'status': 'approved' } )
      .then( account => {  // create customer if needed
        if ( account ) customerId = account.sUserId;
        return !customerId ? createCustomer( stripe, { user: user } ) : undefined;
      })
      .then( customer => {
        if ( customer ) customerId = customer.id;
        payAccount = new PayAccount({
          uid: user._id,
          service: 'stripe'
        });
        let prom = [ ];
        let data = { customerId: customerId, token: token, payAccount: payAccount };
        prom.push( payAccount.save( ) );  // .0 pay account
        prom.push( createCustomerSource( stripe, data, request ) ); // .1 source
        return Promise.all( prom );
      })
      .then( resp => {
        let source = resp[1]; // .1 source
        payAccount.originalRequest = request;
        payAccount.originalResponse = source;
        payAccount.status = 'approved';
        payAccount.sUserId = customerId;
        payAccount.sAccountId = source.id;
        payAccount.data = { };
        payAccount.data.type = source.object;
        payAccount.data.brand = source.brand;
        payAccount.data.country = source.country ? source.country.toUpperCase( ) : undefined;
        payAccount.data.endsIn = source.last4;
        if ( source.exp_month && source.exp_year ) {
          payAccount.data.expires = source.exp_month.toString( ).padStart( 2, '0') +
                                    source.exp_year.toString( ).slice(-2);
        }
        switch ( source.tokenization_method ) { // TODO: these names should go into a definition
          case 'apple_pay':   { payAccount.data.method = 'applePay'  } break;
          case 'android_pay': { payAccount.data.method = 'googlePay' } break;
        }
        return payAccount.save( );
      })
      .catch( err => {
        error = err; // assume it was not the db
        if ( payAccount ) {
          payAccount.originalRequest = request;
          payAccount.originalResponse = ( error.raw && error.raw.type ) ? error.raw : error;  // stripe error on api call
          payAccount.status = 'rejected';
        }
        return payAccount ? payAccount.save( ) : undefined;
      })
      .then( ( ) => {
        if ( error ) throw error;
        return payAccount;
      })
      .then(resolve)
      .catch(reject);
  });
}

// returns the amount as required by Stripe, according to the currency
function toStripeAmount( amount, currency ) {
  // TODO: needs currency and amount validation more precisely
  // https://stripe.com/docs/currencies#zero-decimal
  let ret = amount;  // original amount
  let cur = currency.toUpperCase( );
  if ( !zeroDecimalCurrencies.find( e => e == cur ) ) {
    ret = ret * 100;  // multiply by the smallest unit... which we don't have!
    // TODO: get a list of smallest units by currency. it's usually 100
  }
  return Math.round( ret );  // make it integer... although value is supposed to be integer already
}

// returns the amount as a regular number, from Stripe format, according to the currency
function fromStripeAmount( amount, currency ) {
  // TODO: needs currency and amount validation more precisely
  // https://stripe.com/docs/currencies#zero-decimal
  let ret = amount;  // original amount
  let cur = currency.toUpperCase( );
  if ( !zeroDecimalCurrencies.find( e => e == cur ) ) {
    // divide by the smallest unit... which we don't have!
    ret = Math.round( ( (ret/100) + Number.EPSILON) * 100 ) / 100; // make sure it shows as a 2 decimal number
    // TODO: get a list of smallest units by currency. it's usually 100
  }
  return ret;
}

// checks whether target object (dts) exists and is empty ( { } )
// then assigns properties from source object (src)
function assignToEmptyObject( dst, src ) {
  if ( dst && Object.keys(dst).length === 0 && dst.constructor === Object ) {
    Object.assign( dst, src );
    // undefined properties are kept in database as null because of mongoose mixed type. remove them:
    for ( key in dst ) {
      if ( dst[key] === undefined ) {
        delete dst[key];
      }
    }
  }
}

module.exports = Adapter;