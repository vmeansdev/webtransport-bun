WebTransport 

[  ](https://www.w3.org/) 

# WebTransport

[Editor’s Draft](https://www.w3.org/standards/types/#ED),4 February 2026

More details about this document This version:<https://w3c.github.io/webtransport/> Latest published version:<https://www.w3.org/TR/webtransport/> Feedback:[public-webtransport@w3.org](mailto:public-webtransport@w3.org?subject=%5Bwebtransport%5D%20YOUR%20TOPIC%20HERE) with subject line “\[webtransport\] _… message topic …_” ([archives](https://lists.w3.org/Archives/Public/public-webtransport/)) 

[GitHub](https://github.com/w3c/webtransport/issues/) 

[Inline In Spec](#issues-index) Editors:Nidhi Jaju (Google)

Victor Vasiliev (Google)

Jan-Ivar Bruaroey (Mozilla)Former Editors:

Bernard Aboba (Microsoft Corporation)

Peter Thatcher (Google)

Robin Raymond (Optical Tone Ltd.)

Yutaka Hirano (Google) 

[Copyright](https://www.w3.org/policies/#copyright) © 2026 [World Wide Web Consortium](https://www.w3.org/). W3C® [liability](https://www.w3.org/policies/#Legal%5FDisclaimer), [trademark](https://www.w3.org/policies/#W3C%5FTrademarks) and [permissive document license](https://www.w3.org/copyright/software-license/ "W3C Software and Document License") rules apply.

---

## Abstract

This document defines a set of ECMAScript APIs in WebIDL to allow data to be sent and received between a browser and server, utilizing [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework"). This specification is being developed in conjunction with protocol specifications developed by the IETF WEBTRANS Working Group.

## Status of this document

 This is a public copy of the editors’ draft. It is provided for discussion only and may change at any moment. Its publication here does not imply endorsement of its contents by W3C. Don’t cite this document other than as work in progress.

 Feedback and comments on this document are welcome. Please[file an issue](https://github.com/w3c/webtransport/issues) in this document’s[GitHub repository](https://github.com/w3c/webtransport/).

 This document was produced by the[WebTransport Working Group](https://www.w3.org/groups/wg/webtransport).

 This document was produced by a group operating under the [W3C Patent Policy](https://www.w3.org/policies/patent-policy/). W3C maintains a [public list of any patent disclosures](https://www.w3.org/2004/01/pp-impl/125908/status) made in connection with the deliverables of the group; that page also includes instructions for disclosing a patent. An individual who has actual knowledge of a patent that the individual believes contains [Essential Claim(s)](https://www.w3.org/policies/patent-policy/#def-essential) must disclose the information in accordance with [section 6 of the W3C Patent Policy](https://www.w3.org/policies/patent-policy/#sec-Disclosure).

 This document is governed by the [18 August 2025 W3C Process Document](https://www.w3.org/policies/process/20250818/).

## 1\. Introduction[](#introduction)

_This section is non-normative._

This specification uses [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") to send data to and receive data from servers. It can be used like WebSockets but with support for multiple streams, unidirectional streams, out-of-order delivery, and reliable as well as unreliable transport.

Note: The API presented in this specification represents a preliminary proposal based on work-in-progress within the IETF WEBTRANS WG. Since the [\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3")and [\[WEB-TRANSPORT-HTTP2\]](#biblio-web-transport-http2 "WebTransport over HTTP/2") specifications are a work-in-progress, both the protocol and API are likely to change significantly going forward.

## 2\. Conformance[](#conformance)

As well as sections marked as non-normative, all authoring guidelines, diagrams, examples, and notes in this specification are non-normative. Everything else in this specification is normative.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to be interpreted as described in[\[RFC2119\]](#biblio-rfc2119 "Key words for use in RFCs to Indicate Requirement Levels") and [\[RFC8174\]](#biblio-rfc8174 "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words") when, and only when, they appear in all capitals, as shown here.

This specification defines conformance criteria that apply to a single product: the user agent that implements the interfaces that it contains.

Conformance requirements phrased as algorithms or specific steps may be implemented in any manner, so long as the end result is equivalent. (In particular, the algorithms defined in this specification are intended to be easy to follow, and not intended to be performant.)

Implementations that use ECMAScript to implement the APIs defined in this specification MUST implement them in a manner consistent with the ECMAScript Bindings defined in the Web IDL specification [\[WEBIDL\]](#biblio-webidl "Web IDL Standard"), as this specification uses that specification and terminology.

## 3\. Protocol concepts[](#protocol-concepts)

There are two main protocol concepts for WebTransport: sessions and streams. Each [WebTransport session](#protocol-webtransport-session) can contain multiple [WebTransport streams](#protocol-webtransport-stream).

These should not be confused with [protocol names](#protocol-names) which is an application-level API construct.

### 3.1\. WebTransport session[](#webtransport-session)

A WebTransport session is a session of WebTransport over an HTTP/3 or HTTP/2 underlying [connection](https://fetch.spec.whatwg.org/#concept-connection). There may be multiple [WebTransport sessions](#protocol-webtransport-session) on one [connection](https://fetch.spec.whatwg.org/#concept-connection), when pooling is enabled.

A [WebTransport session](#protocol-webtransport-session) has the following capabilities defined in [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework"):

capability

definition 

send a [datagram](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#name-datagrams) 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.2](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.2-6.2.1) 

receive a [datagram](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#name-datagrams) 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.2](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.2-6.4.1) 

create an [outgoing unidirectional](#stream-outgoing-unidirectional) stream 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.3-7.2.1) 

create a [bidirectional](#stream-bidirectional) stream 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.3-7.4.1) 

receive an [incoming unidirectional](#stream-incoming-unidirectional) stream 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.3-7.6.1) 

receive a [bidirectional](#stream-bidirectional) stream 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.3-7.8.1) 

A [WebTransport session](#protocol-webtransport-session) session is draining when the [CONNECT stream](#connect-stream) is asked to gracefully close by the server, as described in [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11/#section-4.1).

To terminate a [WebTransport session](#protocol-webtransport-session) session with an optional integercode and an optional [byte sequence](https://infra.spec.whatwg.org/#byte-sequence) reason, follow [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.1-2.2.1).

A [WebTransport session](#protocol-webtransport-session) session is terminated, with optionally an integer code and a [byte sequence](https://infra.spec.whatwg.org/#byte-sequence) reason, when the [CONNECT stream](#connect-stream) is closed by the server, as described at [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.1-4.2.1).

### 3.2\. WebTransport stream[](#webtransport-stream)

A WebTransport stream is a concept for a reliable in-order stream of bytes on a [WebTransport session](#protocol-webtransport-session), as described in [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.3).

A [WebTransport stream](#protocol-webtransport-stream) is one of incoming unidirectional,outgoing unidirectional or bidirectional.

A [WebTransport stream](#protocol-webtransport-stream) has the following capabilities:

capability

definition

[incoming unidirectional](#stream-incoming-unidirectional) 

[outgoing unidirectional](#stream-outgoing-unidirectional) 

[bidirectional](#stream-bidirectional) 

send bytes (potentially with FIN)

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.3-9.2.1) 

No

Yes

Yes 

receive bytes (potentially with FIN)

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.3-9.4.1) 

Yes

No

Yes 

abort receiving on a [WebTransport stream](#protocol-webtransport-stream) 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11.html#section-4.3-9.8.1) 

Yes

No

Yes 

abort sending on a [WebTransport stream](#protocol-webtransport-stream) 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11.html#section-4.3-9.6.1) 

No

Yes

Yes

A [WebTransport stream](#protocol-webtransport-stream) has the following signals:

event

definition

[incoming unidirectional](#stream-incoming-unidirectional) 

[outgoing unidirectional](#stream-outgoing-unidirectional) 

[bidirectional](#stream-bidirectional) 

receiving aborted 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11.html#section-4.3-11.4.1) 

No

Yes

Yes 

sending aborted 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11.html#section-4.3-11.2.1) 

Yes

No

Yes 

flow control 

[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.3-5) 

No

Yes

Yes

## 4\. `WebTransportDatagramsWritable` Interface[](#datagram-writable)

A `WebTransportDatagramsWritable` is a `[WritableStream](https://streams.spec.whatwg.org/#writablestream)` providing outgoing streaming features to [ send datagrams](#session-send-a-datagram).

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext), [Transferable](https://html.spec.whatwg.org/multipage/structured-data.html#transferable)]
interface [WebTransportDatagramsWritable](#webtransportdatagramswritable) : [WritableStream](https://streams.spec.whatwg.org/#writablestream) {
  attribute [WebTransportSendGroup](#webtransportsendgroup)? [sendGroup](#dom-webtransportdatagramswritable-sendgroup);
  attribute [long long](https://webidl.spec.whatwg.org/#idl-long-long) [sendOrder](#dom-webtransportdatagramswritable-sendorder);
};

### 4.1\. Internal slots[](#datagram-writable-internal-slots)

A `[WebTransportDatagramsWritable](#webtransportdatagramswritable)` object has the following internal slot.

Internal Slot

Description (_non-normative_) 

`[[OutgoingDatagramsQueue]]` 

A queue of tuples of an outgoing datagram, a timestamp and a promise which is resolved when the datagram is sent or discarded. 

`[[Transport]]` 

The `[WebTransport](#webtransport)` that owns this `[WebTransportDatagramsWritable](#webtransportdatagramswritable)`. 

`[[SendGroup]]` 

An optional `[WebTransportSendGroup](#webtransportsendgroup)`, or null. 

`[[SendOrder]]` 

An optional send order number, defaulting to 0.

 To create a`[WebTransportDatagramsWritable](#webtransportdatagramswritable)`, given a `[WebTransport](#webtransport)` transport, a sendGroup, and a sendOrder, perform the following steps. 

Let stream be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportDatagramsWritable](#webtransportdatagramswritable)`, with:

`[[[OutgoingDatagramsQueue]]](#dom-webtransportdatagramswritable-outgoingdatagramsqueue-slot)` 

an empty queue

`[[[Transport]]](#dom-webtransportdatagramswritable-transport-slot)` 

transport

`[[[SendGroup]]](#dom-webtransportdatagramswritable-sendgroup-slot)` 

sendGroup

`[[[SendOrder]]](#dom-webtransportdatagramswritable-sendorder-slot)` 

sendOrder

* Let writeDatagramsAlgorithm be an action that runs [writeDatagrams](#writedatagrams) withtransport and stream.
* [Set up](https://streams.spec.whatwg.org/#writablestream-set-up) stream with [writeAlgorithm](https://streams.spec.whatwg.org/#writablestream-set-up-writealgorithm) set to writeDatagramsAlgorithm.
* Return stream.

### 4.2\. Attributes[](#datagram-writable-attributes)

`sendGroup`,  of type [WebTransportSendGroup](#webtransportsendgroup), nullable 

The getter steps are:

1. Return [this](https://webidl.spec.whatwg.org/#this)’s `[[[SendGroup]]](#dom-webtransportdatagramswritable-sendgroup-slot)`.

The setter steps, given value, are:

1. If value is non-null, andvalue.`[[[Transport]]](#dom-webtransportsendgroup-transport-slot)` is not[this](https://webidl.spec.whatwg.org/#this).`[[[Transport]]](#dom-webtransportdatagramswritable-transport-slot)`, [throw](https://webidl.spec.whatwg.org/#dfn-throw) an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
2. Set [this](https://webidl.spec.whatwg.org/#this).`[[[SendGroup]]](#dom-webtransportdatagramswritable-sendgroup-slot)` to value.
`sendOrder`,  of type [long long](https://webidl.spec.whatwg.org/#idl-long-long) 

The getter steps are:

1. Return [this](https://webidl.spec.whatwg.org/#this)’s `[[[SendOrder]]](#dom-webtransportdatagramswritable-sendorder-slot)`.

The setter steps, given value, are:

1. Set [this](https://webidl.spec.whatwg.org/#this).`[[[SendOrder]]](#dom-webtransportdatagramswritable-sendorder-slot)` to value.

### 4.3\. Procedures[](#datagram-writable-procedures)

The writeDatagrams algorithm is given a transport and writable as parameters anddata as input. It is defined by running the following steps:

1. Let timestamp be a timestamp representing now.
2. If data is not a `[BufferSource](https://webidl.spec.whatwg.org/#BufferSource)` object, then return [a promise rejected with](https://webidl.spec.whatwg.org/#a-promise-rejected-with) a `[TypeError](https://webidl.spec.whatwg.org/#exceptiondef-typeerror)`.
3. Let datagrams be transport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.
4. If datagrams.`[[[OutgoingMaxDatagramSize]]](#dom-webtransportdatagramduplexstream-outgoingmaxdatagramsize-slot)` is less than data’s \[\[ByteLength\]\], return[a promise resolved with](https://webidl.spec.whatwg.org/#a-promise-resolved-with) undefined.
5. Let promise be a new promise.
6. Let bytes be a copy of bytes which data represents.
7. Let chunk be a tuple of bytes, timestamp and promise.
8. Enqueue chunk to writable.`[[[OutgoingDatagramsQueue]]](#dom-webtransportdatagramswritable-outgoingdatagramsqueue-slot)`.
9. If the length of writable.`[[[OutgoingDatagramsQueue]]](#dom-webtransportdatagramswritable-outgoingdatagramsqueue-slot)` is less thandatagrams.`[[[OutgoingDatagramsHighWaterMark]]](#dom-webtransportdatagramduplexstream-outgoingdatagramshighwatermark-slot)`, then [resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with undefined.
10. Return promise.

Note: The associated `[WritableStream](https://streams.spec.whatwg.org/#writablestream)` calls [writeDatagrams](#writedatagrams) only when all the promises that have been returned by [writeDatagrams](#writedatagrams) for that stream have been resolved. Hence the timestamp and the expiration duration work well only when the web developer pays attention to`[WritableStreamDefaultWriter.ready](https://streams.spec.whatwg.org/#default-writer-ready)`.

To sendDatagrams, given a `[WebTransport](#webtransport)` object transport and a`[WebTransportDatagramsWritable](#webtransportdatagramswritable)` object writable, [queue a network task](#webtransport-queue-a-network-task)with transport to run the following steps:

1. Let queue be a copy of writable.`[[[OutgoingDatagramsQueue]]](#dom-webtransportdatagramswritable-outgoingdatagramsqueue-slot)`.  
Note: The above copy, as well as the queueing of a network task to run these steps, can be optimized.
2. Let maxSize be transport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[OutgoingMaxDatagramSize]]](#dom-webtransportdatagramduplexstream-outgoingmaxdatagramsize-slot)`.
3. Let duration be transport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[OutgoingDatagramsExpirationDuration]]](#dom-webtransportdatagramduplexstream-outgoingdatagramsexpirationduration-slot)`.
4. If duration is null, then set duration to an [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined) value.
5. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. While queue is not empty:  
         1. Let bytes, timestamp and promise be queue’s first element.  
         2. If more than duration milliseconds have passed since timestamp, then:  
                  1. Remove the first element from queue.  
                  2. [Queue a network task](#webtransport-queue-a-network-task) with transport to [resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with undefined.  
         3. Otherwise, break this loop.  
   2. If transport.`[[[State]]](#dom-webtransport-state-slot)` is not `"connected"`, then return.  
   3. While queue is not empty:  
         1. Let bytes, timestamp and promise be queue’s first element.  
         2. If bytes’s length ≤ maxSize:  
                  1. If it is not possible to send bytes to the network immediately, then break this loop.  
                  2. [Send a datagram](#session-send-a-datagram), with transport.`[[[Session]]](#dom-webtransport-session-slot)` and bytes.  
         3. Remove the first element from queue.  
         4. [Queue a network task](#webtransport-queue-a-network-task) with transport to [resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with undefined.

The user agent MUST, for any `[WebTransport](#webtransport)` object whose`[[[State]]](#dom-webtransport-state-slot)` is `"connecting"` or `"connected"`, run [sendDatagrams](#senddatagrams) on a subset (determined by [send-order rules](#send-order-rules)) of its associated `[WebTransportDatagramsWritable](#webtransportdatagramswritable)`objects, and SHOULD do so as soon as reasonably possible whenever the algorithm can make progress.

The send-order rules are that sending in general MAY be interleaved with sending of previously queued streams and datagrams, as well as streams and datagrams yet to be queued to be sent over this transport, except that sending MUST starve until all bytes queued for sending on streams and datagrams with the same`[[[SendGroup]]](#dom-webtransportdatagramswritable-sendgroup-slot)` and a higher`[[[SendOrder]]](#dom-webtransportdatagramswritable-sendorder-slot)`, that are neither[ errored](https://streams.spec.whatwg.org/#writablestream-error) nor blocked by [flow control](#stream-signal-flow-control), have been sent.

Note: Writing datagrams while the transport’s `[[[State]]](#dom-webtransport-state-slot)` is `"connecting"` is allowed. The datagrams are stored in `[[[OutgoingDatagramsQueue]]](#dom-webtransportdatagramswritable-outgoingdatagramsqueue-slot)`, and they can be discarded in the same manner as when in the `"connected"` state. Once the transport’s `[[[State]]](#dom-webtransport-state-slot)` becomes`"connected"`, it will start sending the queued datagrams.

## 5\. `WebTransportDatagramDuplexStream` Interface[](#datagram-duplex-stream)

A `WebTransportDatagramDuplexStream` is a generic duplex stream.

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface [WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream) {
  [WebTransportDatagramsWritable](#webtransportdatagramswritable) [createWritable](#dom-webtransportdatagramduplexstream-createwritable)(
      optional [WebTransportSendOptions](#dictdef-webtransportsendoptions) `options` = {});
  readonly attribute [ReadableStream](https://streams.spec.whatwg.org/#readablestream) [readable](#dom-webtransportdatagramduplexstream-readable);

  readonly attribute [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long) [maxDatagramSize](#dom-webtransportdatagramduplexstream-maxdatagramsize);
  attribute [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double)? [incomingMaxAge](#dom-webtransportdatagramduplexstream-incomingmaxage);
  attribute [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double)? [outgoingMaxAge](#dom-webtransportdatagramduplexstream-outgoingmaxage);
  attribute [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double) [incomingHighWaterMark](#dom-webtransportdatagramduplexstream-incominghighwatermark);
  attribute [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double) [outgoingHighWaterMark](#dom-webtransportdatagramduplexstream-outgoinghighwatermark);
};

### 5.1\. Internal slots[](#datagram-duplex-stream-internal-slots)

A `[WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream)` object has the following internal slots.

Internal Slot

Description (_non-normative_) 

`[[Transport]]` 

The `[WebTransport](#webtransport)` that owns this `[WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream)`. 

`[[Readable]]` 

A `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)` for incoming datagrams. 

`[[ReadableType]]` 

The `[ReadableStreamType](https://streams.spec.whatwg.org/#enumdef-readablestreamtype)` used for incoming datagrams. 

`[[Writables]]` 

An [ordered set](https://infra.spec.whatwg.org/#ordered-set) of `[WebTransportDatagramsWritable](#webtransportdatagramswritable)` streams, initially empty. 

`[[IncomingDatagramsQueue]]` 

A queue of pairs of an incoming datagram and a timestamp. 

`[[IncomingDatagramsPullPromise]]` 

A promise set by [pullDatagrams](#pulldatagrams), to wait for an incoming datagram. 

`[[IncomingDatagramsHighWaterMark]]` 

An `[unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double)` representing the[high water mark](https://streams.spec.whatwg.org/#high-water-mark) of the incoming datagrams. 

`[[IncomingDatagramsExpirationDuration]]` 

An `[unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double)` representing the expiration duration for incoming datagrams (in milliseconds), or null. 

`[[OutgoingDatagramsHighWaterMark]]` 

An `[unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double)` representing the[high water mark](https://streams.spec.whatwg.org/#high-water-mark) of the outgoing datagrams. 

`[[OutgoingDatagramsExpirationDuration]]` 

An `[unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double)` value representing the expiration duration for outgoing datagrams (in milliseconds), or null. 

`[[OutgoingMaxDatagramSize]]` 

 An integer representing the maximum size for an outgoing datagram.

 The maximum datagram size depends on the protocol that is in use. In HTTP/3 [\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3"), the value is related to the estimate of the path MTU, which is reduced by some implementation-defined amount to account for any overheads. In HTTP/2 [\[WEB-TRANSPORT-HTTP2\]](#biblio-web-transport-http2 "WebTransport over HTTP/2"), there is no equivalent limit.

As the processing of datagrams generally involves holding the entire datagram in memory, implementations will have limits on size. A future protocol extension could enable the signaling of these size limits for all protocol variants.

The user agent MAY update `[[[OutgoingMaxDatagramSize]]](#dom-webtransportdatagramduplexstream-outgoingmaxdatagramsize-slot)` for any `[WebTransport](#webtransport)` object whose`[[[State]]](#dom-webtransport-state-slot)` is either `"connecting"` or `"connected"`.

 To create a`[WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream)` given a `[WebTransport](#webtransport)` transport, areadable and readableType, perform the following steps. 

Let stream be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream)`, with:

`[[[Transport]]](#dom-webtransportdatagramduplexstream-transport-slot)` 

transport

`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)` 

readable

`[[[ReadableType]]](#dom-webtransportdatagramduplexstream-readabletype-slot)` 

readableType

`[[[Writables]]](#dom-webtransportdatagramduplexstream-writables-slot)` 

an empty [ordered set](https://infra.spec.whatwg.org/#ordered-set).

`[[[IncomingDatagramsQueue]]](#dom-webtransportdatagramduplexstream-incomingdatagramsqueue-slot)` 

an empty queue

`[[[IncomingDatagramsPullPromise]]](#dom-webtransportdatagramduplexstream-incomingdatagramspullpromise-slot)` 

null

`[[[IncomingDatagramsHighWaterMark]]](#dom-webtransportdatagramduplexstream-incomingdatagramshighwatermark-slot)` 

an [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined) value

`[[[IncomingDatagramsExpirationDuration]]](#dom-webtransportdatagramduplexstream-incomingdatagramsexpirationduration-slot)` 

null

`[[[OutgoingDatagramsHighWaterMark]]](#dom-webtransportdatagramduplexstream-outgoingdatagramshighwatermark-slot)` 

an [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined) value

This implementation-defined value should be tuned to ensure decent throughput, without jeopardizing the timeliness of transmitted data.

`[[[OutgoingDatagramsExpirationDuration]]](#dom-webtransportdatagramduplexstream-outgoingdatagramsexpirationduration-slot)` 

null

`[[[OutgoingMaxDatagramSize]]](#dom-webtransportdatagramduplexstream-outgoingmaxdatagramsize-slot)` 

an [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined) integer.

* Return stream.

### 5.2\. Methods[](#datagram-duplex-stream-methods)

`createWritable()` 

Creates a `[WebTransportDatagramsWritable](#webtransportdatagramswritable)`.

 When `createWritable()` method is called, the user agent MUST run the following steps:
1. Let transport be `[WebTransport](#webtransport)` object associated with [this](https://webidl.spec.whatwg.org/#this).
2. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`,[throw](https://webidl.spec.whatwg.org/#dfn-throw) an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
3. Let sendGroup be `[options](#dom-webtransportdatagramduplexstream-createwritable-options-options)`’s`[sendGroup](#dom-webtransportsendoptions-sendgroup)`.
4. If sendGroup is not null, andsendGroup.`[[[Transport]]](#dom-webtransportsendgroup-transport-slot)` is not[this](https://webidl.spec.whatwg.org/#this).`[[[Transport]]](#dom-webtransportdatagramduplexstream-transport-slot)`, [throw](https://webidl.spec.whatwg.org/#dfn-throw) an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
5. Let sendOrder be `[options](#dom-webtransportdatagramduplexstream-createwritable-options-options)`’s`[sendOrder](#dom-webtransportsendoptions-sendorder)`.
6. Return the result of [creating](#webtransportdatagramswritable-create) a `[WebTransportDatagramsWritable](#webtransportdatagramswritable)` with transport, sendGroup and sendOrder.

### 5.3\. Attributes[](#datagram-duplex-stream-attributes)

`readable`,  of type [ReadableStream](https://streams.spec.whatwg.org/#readablestream), readonly 

The getter steps are:

1. Return [this](https://webidl.spec.whatwg.org/#this).`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`.
`incomingMaxAge`,  of type [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double), nullable 

The getter steps are:

1. Return [this](https://webidl.spec.whatwg.org/#this).`[[[IncomingDatagramsExpirationDuration]]](#dom-webtransportdatagramduplexstream-incomingdatagramsexpirationduration-slot)`.

The setter steps, given value, are:

1. If value is negative or NaN, [throw](https://webidl.spec.whatwg.org/#dfn-throw) a `[RangeError](https://webidl.spec.whatwg.org/#exceptiondef-rangeerror)`.
2. If value is `0`, set value to null.
3. Set [this](https://webidl.spec.whatwg.org/#this).`[[[IncomingDatagramsExpirationDuration]]](#dom-webtransportdatagramduplexstream-incomingdatagramsexpirationduration-slot)` to value.
`maxDatagramSize`,  of type [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long), readonly 

The maximum size data that may be passed to a `[WebTransportDatagramsWritable](#webtransportdatagramswritable)`. The getter steps are to return [this](https://webidl.spec.whatwg.org/#this).`[[[OutgoingMaxDatagramSize]]](#dom-webtransportdatagramduplexstream-outgoingmaxdatagramsize-slot)`.

`outgoingMaxAge`,  of type [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double), nullable 

The getter steps are:

1. Return [this](https://webidl.spec.whatwg.org/#this)’s `[[[OutgoingDatagramsExpirationDuration]]](#dom-webtransportdatagramduplexstream-outgoingdatagramsexpirationduration-slot)`.

The setter steps, given value, are:

1. If value is negative or NaN, [throw](https://webidl.spec.whatwg.org/#dfn-throw) a `[RangeError](https://webidl.spec.whatwg.org/#exceptiondef-rangeerror)`.
2. If value is `0`, set value to null.
3. Set [this](https://webidl.spec.whatwg.org/#this).`[[[OutgoingDatagramsExpirationDuration]]](#dom-webtransportdatagramduplexstream-outgoingdatagramsexpirationduration-slot)` to value.
`incomingHighWaterMark`,  of type [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double) 

The getter steps are:

1. Return [this](https://webidl.spec.whatwg.org/#this).`[[[IncomingDatagramsHighWaterMark]]](#dom-webtransportdatagramduplexstream-incomingdatagramshighwatermark-slot)`.

The setter steps, given value, are:

1. If value is negative or NaN, [throw](https://webidl.spec.whatwg.org/#dfn-throw) a `[RangeError](https://webidl.spec.whatwg.org/#exceptiondef-rangeerror)`.
2. If value is < `1`, set value to `1`.
3. Set [this](https://webidl.spec.whatwg.org/#this).`[[[IncomingDatagramsHighWaterMark]]](#dom-webtransportdatagramduplexstream-incomingdatagramshighwatermark-slot)` to value.
`outgoingHighWaterMark`,  of type [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double) 

The getter steps are:

1. Return [this](https://webidl.spec.whatwg.org/#this).`[[[OutgoingDatagramsHighWaterMark]]](#dom-webtransportdatagramduplexstream-outgoingdatagramshighwatermark-slot)`.

The setter steps, given value, are:

1. If value is negative or NaN, [throw](https://webidl.spec.whatwg.org/#dfn-throw) a `[RangeError](https://webidl.spec.whatwg.org/#exceptiondef-rangeerror)`.
2. If value is < `1`, set value to `1`.
3. Set [this](https://webidl.spec.whatwg.org/#this).`[[[OutgoingDatagramsHighWaterMark]]](#dom-webtransportdatagramduplexstream-outgoingdatagramshighwatermark-slot)` to value.

### 5.4\. Procedures[](#datagram-duplex-stream-procedures)

To pullDatagrams, given a `[WebTransport](#webtransport)` object transport, run these steps:

1. Let datagrams be transport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.
2. Assert: datagrams.`[[[IncomingDatagramsPullPromise]]](#dom-webtransportdatagramduplexstream-incomingdatagramspullpromise-slot)` is null.
3. Let queue be datagrams.`[[[IncomingDatagramsQueue]]](#dom-webtransportdatagramduplexstream-incomingdatagramsqueue-slot)`.
4. If queue is empty, then:  
   1. Set datagrams.`[[[IncomingDatagramsPullPromise]]](#dom-webtransportdatagramduplexstream-incomingdatagramspullpromise-slot)` to a new promise.  
   2. Return datagrams.`[[[IncomingDatagramsPullPromise]]](#dom-webtransportdatagramduplexstream-incomingdatagramspullpromise-slot)`.
5. Let datagram and timestamp be the result of [dequeuing](https://infra.spec.whatwg.org/#queue-dequeue) queue.
6. If datagrams.`[[[ReadableType]]](#dom-webtransportdatagramduplexstream-readabletype-slot)` is `"bytes"`, then:  
   1. If datagrams.`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`’s[current BYOB request view](https://streams.spec.whatwg.org/#readablestream-current-byob-request-view) is not null, then:  
         1. Let view be datagrams.`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`’s[current BYOB request view](https://streams.spec.whatwg.org/#readablestream-current-byob-request-view).  
         2. If view’s [byte length](https://webidl.spec.whatwg.org/#buffersource-byte-length) is less than the size of datagram, return[a promise rejected with](https://webidl.spec.whatwg.org/#a-promise-rejected-with) a `[RangeError](https://webidl.spec.whatwg.org/#exceptiondef-rangeerror)`.  
         3. Let elementSize be the element size specified in [the typed array constructors table](http://www.ecma-international.org/ecma-262/6.0/index.html#table-49) forview.\[\[TypedArrayName\]\]. If view does not have a \[\[TypedArrayName\]\] internal slot (i.e. it is a `[DataView](https://webidl.spec.whatwg.org/#idl-DataView)`), let elementSize be 0.  
         4. If elementSize is not 1, return [a promise rejected with](https://webidl.spec.whatwg.org/#a-promise-rejected-with) a `[TypeError](https://webidl.spec.whatwg.org/#exceptiondef-typeerror)`.  
   2. [Pull from bytes](https://streams.spec.whatwg.org/#readablestream-pull-from-bytes) datagram intodatagrams.`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`.
7. Otherwise:  
   1. Let chunk be a new `[Uint8Array](https://webidl.spec.whatwg.org/#idl-Uint8Array)` object representing datagram.  
   2. [Enqueue](https://streams.spec.whatwg.org/#readablestream-enqueue) chunk totransport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`.
8. Return [a promise resolved with](https://webidl.spec.whatwg.org/#a-promise-resolved-with) undefined.

To receiveDatagrams, given a `[WebTransport](#webtransport)` object transport, run these steps:

1. Let timestamp be a timestamp representing now.
2. Let queue be datagrams.`[[[IncomingDatagramsQueue]]](#dom-webtransportdatagramduplexstream-incomingdatagramsqueue-slot)`.
3. Let duration be datagrams.`[[[IncomingDatagramsExpirationDuration]]](#dom-webtransportdatagramduplexstream-incomingdatagramsexpirationduration-slot)`.
4. If duration is null, then set duration to an [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined) value.
5. Let session be transport.`[[[Session]]](#dom-webtransport-session-slot)`.
6. While there are [available incoming datagrams](#session-receive-a-datagram) on session:  
   1. Let datagram be the result of [receiving a datagram](#session-receive-a-datagram) with session.  
   2. Let timestamp be a timestamp representing now.  
   3. Let chunk be a pair of datagram and timestamp.  
   4. [Enqueue](https://infra.spec.whatwg.org/#queue-enqueue) chunk to queue.
7. Let toBeRemoved be the length of queue minus datagrams.`[[[IncomingDatagramsHighWaterMark]]](#dom-webtransportdatagramduplexstream-incomingdatagramshighwatermark-slot)`.
8. If toBeRemoved is positive, repeat [dequeuing](https://infra.spec.whatwg.org/#queue-dequeue) queue toBeRemoved ([rounded down](https://tc39.github.io/ecma262/#eqn-floor)) times.
9. While queue is not empty:  
   1. Let bytes and timestamp be queue’s first element.  
   2. If more than duration milliseconds have passed since timestamp, then [dequeue](https://infra.spec.whatwg.org/#queue-dequeue) queue.  
   3. Otherwise, [break](https://infra.spec.whatwg.org/#iteration-break) this loop.
10. If queue is not empty and datagrams.`[[[IncomingDatagramsPullPromise]]](#dom-webtransportdatagramduplexstream-incomingdatagramspullpromise-slot)` is non-null, then:  
   1. Let bytes and timestamp be the result of [dequeuing](https://infra.spec.whatwg.org/#queue-dequeue) queue.  
   2. Let promise be datagrams.`[[[IncomingDatagramsPullPromise]]](#dom-webtransportdatagramduplexstream-incomingdatagramspullpromise-slot)`.  
   3. Set datagrams.`[[[IncomingDatagramsPullPromise]]](#dom-webtransportdatagramduplexstream-incomingdatagramspullpromise-slot)` to null.  
   4. [Queue a network task](#webtransport-queue-a-network-task) with transport to run the following steps:  
         1. Let chunk be a new `[Uint8Array](https://webidl.spec.whatwg.org/#idl-Uint8Array)` object representing bytes.  
         2. [Enqueue](https://streams.spec.whatwg.org/#readablestream-enqueue) chunk to datagrams.`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`.  
         3. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with undefined.

The user agent SHOULD run [receiveDatagrams](#receivedatagrams) for any `[WebTransport](#webtransport)` object whose`[[[State]]](#dom-webtransport-state-slot)` is `"connected"` as soon as reasonably possible whenever the algorithm can make progress.

## 6\. `WebTransport` Interface[](#web-transport)

`WebTransport` provides an API to the underlying transport functionality defined in [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework").

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface `WebTransport` {
  `constructor`([USVString](https://webidl.spec.whatwg.org/#idl-USVString) `url`, optional [WebTransportOptions](#dictdef-webtransportoptions) `options` = {});

  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportConnectionStats](#dictdef-webtransportconnectionstats)> [getStats](#dom-webtransport-getstats)();
  [[NewObject](https://webidl.spec.whatwg.org/#NewObject)] [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[ArrayBuffer](https://webidl.spec.whatwg.org/#idl-ArrayBuffer)> [exportKeyingMaterial](#dom-webtransport-exportkeyingmaterial)([BufferSource](https://webidl.spec.whatwg.org/#BufferSource) `label`, optional [BufferSource](https://webidl.spec.whatwg.org/#BufferSource) `context`);
  readonly attribute [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[undefined](https://webidl.spec.whatwg.org/#idl-undefined)> [ready](#dom-webtransport-ready);
  readonly attribute [WebTransportReliabilityMode](#enumdef-webtransportreliabilitymode) [reliability](#dom-webtransport-reliability);
  readonly attribute [WebTransportCongestionControl](#enumdef-webtransportcongestioncontrol) [congestionControl](#dom-webtransport-congestioncontrol);
  [[EnforceRange](https://webidl.spec.whatwg.org/#EnforceRange)] attribute [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short)? [anticipatedConcurrentIncomingUnidirectionalStreams](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams);
  [[EnforceRange](https://webidl.spec.whatwg.org/#EnforceRange)] attribute [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short)? [anticipatedConcurrentIncomingBidirectionalStreams](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams);
  readonly attribute [DOMString](https://webidl.spec.whatwg.org/#idl-DOMString) [protocol](#dom-webtransport-protocol);

  readonly attribute [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportCloseInfo](#dictdef-webtransportcloseinfo)> [closed](#dom-webtransport-closed);
  readonly attribute [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[undefined](https://webidl.spec.whatwg.org/#idl-undefined)> [draining](#dom-webtransport-draining);
  [undefined](https://webidl.spec.whatwg.org/#idl-undefined) [close](#dom-webtransport-close)(optional [WebTransportCloseInfo](#dictdef-webtransportcloseinfo) `closeInfo` = {});

  readonly attribute [WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream) [datagrams](#dom-webtransport-datagrams);

  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportBidirectionalStream](#webtransportbidirectionalstream)> [createBidirectionalStream](#dom-webtransport-createbidirectionalstream)(
      optional [WebTransportSendStreamOptions](#dictdef-webtransportsendstreamoptions) `options` = {});
  /* a ReadableStream of WebTransportBidirectionalStream objects */
  readonly attribute [ReadableStream](https://streams.spec.whatwg.org/#readablestream) [incomingBidirectionalStreams](#dom-webtransport-incomingbidirectionalstreams);

  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportSendStream](#webtransportsendstream)> [createUnidirectionalStream](#dom-webtransport-createunidirectionalstream)(
      optional [WebTransportSendStreamOptions](#dictdef-webtransportsendstreamoptions) `options` = {});
  /* a ReadableStream of WebTransportReceiveStream objects */
  readonly attribute [ReadableStream](https://streams.spec.whatwg.org/#readablestream) [incomingUnidirectionalStreams](#dom-webtransport-incomingunidirectionalstreams);
  [WebTransportSendGroup](#webtransportsendgroup) [createSendGroup](#dom-webtransport-createsendgroup)();

  static readonly attribute [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [supportsReliableOnly](#dom-webtransport-supportsreliableonly);
};

enum `WebTransportReliabilityMode` {
  `"pending"`,
  `"reliable-only"`,
  `"supports-unreliable"`,
};

### 6.1\. Internal slots[](#webtransport-internal-slots)

A `[WebTransport](#webtransport)` object has the following internal slots.

Internal Slot

Description (_non-normative_) 

`[[SendStreams]]` 

An [ordered set](https://infra.spec.whatwg.org/#ordered-set) of `[WebTransportSendStream](#webtransportsendstream)`s owned by this `[WebTransport](#webtransport)`. 

`[[ReceiveStreams]]` 

An [ordered set](https://infra.spec.whatwg.org/#ordered-set) of `[WebTransportReceiveStream](#webtransportreceivestream)`s owned by this`[WebTransport](#webtransport)`. 

`[[IncomingBidirectionalStreams]]` 

A `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)` consisting of `[WebTransportBidirectionalStream](#webtransportbidirectionalstream)` objects. 

`[[IncomingUnidirectionalStreams]]` 

A `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)` consisting of `[WebTransportReceiveStream](#webtransportreceivestream)`s. 

`[[State]]` 

An enum indicating the state of the transport. One of `"connecting"`,`"connected"`, `"draining"`, `"closed"`, and `"failed"`. 

`[[Ready]]` 

A promise fulfilled when the associated [WebTransport session](#protocol-webtransport-session) gets [established](#session-establish), or rejected if the [establishment process](#session-establish) failed. 

`[[Reliability]]` 

A `[WebTransportReliabilityMode](#enumdef-webtransportreliabilitymode)` indicating whether the first hop supports unreliable (UDP) transport or whether only reliable (TCP fallback) transport is available. Returns `"pending"` until a connection has been established. 

`[[CongestionControl]]` 

A `[WebTransportCongestionControl](#enumdef-webtransportcongestioncontrol)` indicating whether a preference for a congestion control algorithm optimized for throughput or low latency was requested by the application and satisfied by the user agent, or `"default"`. 

`[[AnticipatedConcurrentIncomingUnidirectionalStreams]]` 

The number of concurrently open[incoming unidirectional](#stream-incoming-unidirectional) streams the application anticipates the server creating, or null. 

`[[AnticipatedConcurrentIncomingBidirectionalStreams]]` 

The number of concurrently open[bidirectional](#stream-bidirectional) streams the application anticipates the server creating, or null. 

`[[Protocol]]` 

A string indicating the application-level protocol selected by the server, if any. Initially an empty string. 

`[[Closed]]` 

A promise fulfilled when the associated `[WebTransport](#webtransport)` object is closed gracefully, or rejected when it is closed abruptly or failed on initialization. 

`[[Draining]]` 

A promise fulfilled when the associated [WebTransport session](#protocol-webtransport-session) is [drained](#session-draining). 

`[[Datagrams]]` 

A `[WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream)`. 

`[[Session]]` 

A [WebTransport session](#protocol-webtransport-session) for this `[WebTransport](#webtransport)` object, or null. 

`[[NewConnection]]` 

Either "`no`" or "`yes-and-dedicated`". 

`[[RequireUnreliable]]` 

A boolean indicating whether UDP is required.

### 6.2\. Constructor[](#webtransport-constructor)

When the `[WebTransport()](#dom-webtransport-webtransport)` constructor is invoked, the user agent MUST run the following steps: 
* Let baseURL be [this](https://webidl.spec.whatwg.org/#this)’s [relevant settings object](https://html.spec.whatwg.org/multipage/webappapis.html#relevant-settings-object)’s [API base URL](https://html.spec.whatwg.org/multipage/webappapis.html#api-base-url).
* Let url be the [URL record](https://url.spec.whatwg.org/#concept-url) resulting from [parsing](https://url.spec.whatwg.org/#concept-url-parser) `[url](#dom-webtransport-webtransport-url-options-url)` with baseURL.
* If url is failure, [throw](https://webidl.spec.whatwg.org/#dfn-throw) a `[SyntaxError](https://webidl.spec.whatwg.org/#syntaxerror)` exception.
* If url’s [scheme](https://url.spec.whatwg.org/#concept-url-scheme) is not `https`, [throw](https://webidl.spec.whatwg.org/#dfn-throw) a `[SyntaxError](https://webidl.spec.whatwg.org/#syntaxerror)` exception.
* If url’s [fragment](https://url.spec.whatwg.org/#concept-url-fragment) is not null, [throw](https://webidl.spec.whatwg.org/#dfn-throw) a `[SyntaxError](https://webidl.spec.whatwg.org/#syntaxerror)` exception.
* Let newConnection be "`no`" if `[options](#dom-webtransport-webtransport-url-options-options)`’s`[allowPooling](#dom-webtransportoptions-allowpooling)` is true; otherwise "`yes-and-dedicated`".
* Let serverCertificateHashes be `[options](#dom-webtransport-webtransport-url-options-options)`’s`[serverCertificateHashes](#dom-webtransportoptions-servercertificatehashes)`.
* If newConnection is "`no`" and serverCertificateHashes [is not empty](https://infra.spec.whatwg.org/#list-is-empty), then [throw](https://webidl.spec.whatwg.org/#dfn-throw) a`[NotSupportedError](https://webidl.spec.whatwg.org/#notsupportederror)` exception.
* Let requireUnreliable be `[options](#dom-webtransport-webtransport-url-options-options)`’s`[requireUnreliable](#dom-webtransportoptions-requireunreliable)`.
* Let congestionControl be `[options](#dom-webtransport-webtransport-url-options-options)`’s`[congestionControl](#dom-webtransportoptions-congestioncontrol)`.
* If congestionControl is not `"default"`, and the user agent does not support any congestion control algorithms that optimize for congestionControl, as allowed by[\[RFC9002\]](#biblio-rfc9002 "QUIC Loss Detection and Congestion Control") [Section 7](https://www.rfc-editor.org/rfc/rfc9002#section-7), then set congestionControl to `"default"`.
* Let protocols be `[options](#dom-webtransport-webtransport-url-options-options)`’s`[protocols](#dom-webtransportoptions-protocols)`.
* If any of the values in protocols occur more than once, fail to match the requirements for elements that comprise the value of the negotiated application protocol as defined by the WebTransport protocol, or have an [isomorphic encoded](https://infra.spec.whatwg.org/#isomorphic-encode) length of 0 or exceeding 512, [throw](https://webidl.spec.whatwg.org/#dfn-throw) a `[SyntaxError](https://webidl.spec.whatwg.org/#syntaxerror)` exception.[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 3.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11/#section-3.1).
* Let anticipatedConcurrentIncomingUnidirectionalStreams be `[options](#dom-webtransport-webtransport-url-options-options)`’s`[anticipatedConcurrentIncomingUnidirectionalStreams](#dom-webtransportoptions-anticipatedconcurrentincomingunidirectionalstreams)`.
* Let anticipatedConcurrentIncomingBidirectionalStreams be `[options](#dom-webtransport-webtransport-url-options-options)`’s`[anticipatedConcurrentIncomingBidirectionalStreams](#dom-webtransportoptions-anticipatedconcurrentincomingbidirectionalstreams)`.
* Let datagramsReadableType be `[options](#dom-webtransport-webtransport-url-options-options)`’s`[datagramsReadableType](#dom-webtransportoptions-datagramsreadabletype)`.
* Let incomingDatagrams be a [new](https://webidl.spec.whatwg.org/#new) `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)`.

Let transport be a newly constructed `[WebTransport](#webtransport)` object, with:

`[[[SendStreams]]](#dom-webtransport-sendstreams-slot)` 

an empty [ordered set](https://infra.spec.whatwg.org/#ordered-set)

`[[[ReceiveStreams]]](#dom-webtransport-receivestreams-slot)` 

an empty [ordered set](https://infra.spec.whatwg.org/#ordered-set)

`[[[IncomingBidirectionalStreams]]](#dom-webtransport-incomingbidirectionalstreams-slot)` 

a new `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)`

`[[[IncomingUnidirectionalStreams]]](#dom-webtransport-incomingunidirectionalstreams-slot)` 

a new `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)`

`[[[State]]](#dom-webtransport-state-slot)` 

`"connecting"`

`[[[Ready]]](#dom-webtransport-ready-slot)` 

a new promise

`[[[Reliability]]](#dom-webtransport-reliability-slot)` 

"pending"

`[[[CongestionControl]]](#dom-webtransport-congestioncontrol-slot)` 

congestionControl

`[[[AnticipatedConcurrentIncomingUnidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams-slot)` 

anticipatedConcurrentIncomingUnidirectionalStreams

`[[[AnticipatedConcurrentIncomingBidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams-slot)` 

anticipatedConcurrentIncomingBidirectionalStreams

`[[[Protocol]]](#dom-webtransport-protocol-slot)` 

an empty string

`[[[Closed]]](#dom-webtransport-closed-slot)` 

a new promise

`[[[Draining]]](#dom-webtransport-draining-slot)` 

a new promise

`[[[Datagrams]]](#dom-webtransport-datagrams-slot)` 

undefined

`[[[Session]]](#dom-webtransport-session-slot)` 

null

`[[[NewConnection]]](#dom-webtransport-newconnection-slot)` 

newConnection

`[[[RequireUnreliable]]](#dom-webtransport-requireunreliable-slot)` 

requireUnreliable

* Set transport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)` to the result of [creating](#webtransportdatagramduplexstream-create) a `[WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream)`, with transport, incomingDatagrams anddatagramsReadableType.
* Let pullDatagramsAlgorithm be an action that runs [pullDatagrams](#pulldatagrams) with transport.  
Note: Using 64 kibibytes buffers with datagrams is recommended because the effective maximum WebTransport datagram frame size has an upper bound of the QUIC maximum datagram frame size which is recommended to be 64 kibibytes (See [\[QUIC-DATAGRAM\]](#biblio-quic-datagram "An Unreliable Datagram Extension to QUIC") [Section 3](https://datatracker.ietf.org/doc/html/rfc9221#section-3)). This will ensure the stream is not errored due to a datagram being larger than the buffer.
* If datagramsReadableType is `"bytes"`, [set up with byte reading support](https://streams.spec.whatwg.org/#readablestream-set-up-with-byte-reading-support) incomingDatagrams with [pullAlgorithm](https://streams.spec.whatwg.org/#readablestream-set-up-with-byte-reading-support-pullalgorithm) set to pullDatagramsAlgorithm, and [highWaterMark](https://streams.spec.whatwg.org/#readablestream-set-up-with-byte-reading-support-highwatermark) set to 0\. Otherwise, [set up](https://streams.spec.whatwg.org/#readablestream-set-up) incomingDatagrams with[pullAlgorithm](https://streams.spec.whatwg.org/#readablestream-set-up-pullalgorithm) set to pullDatagramsAlgorithm, and[highWaterMark](https://streams.spec.whatwg.org/#readablestream-set-up-highwatermark) set to 0.
* Let pullBidirectionalStreamAlgorithm be an action that runs [pullBidirectionalStream](#pullbidirectionalstream) with transport.
* [Set up](https://streams.spec.whatwg.org/#readablestream-set-up) transport.`[[[IncomingBidirectionalStreams]]](#dom-webtransport-incomingbidirectionalstreams-slot)` with[pullAlgorithm](https://streams.spec.whatwg.org/#readablestream-set-up-pullalgorithm) set to pullBidirectionalStreamAlgorithm, and[highWaterMark](https://streams.spec.whatwg.org/#readablestream-set-up-highwatermark) set to 0.
* Let pullUnidirectionalStreamAlgorithm be an action that runs [pullUnidirectionalStream](#pullunidirectionalstream) with transport.
* [Set up](https://streams.spec.whatwg.org/#readablestream-set-up) transport.`[[[IncomingUnidirectionalStreams]]](#dom-webtransport-incomingunidirectionalstreams-slot)` with[pullAlgorithm](https://streams.spec.whatwg.org/#readablestream-set-up-pullalgorithm) set to pullUnidirectionalStreamAlgorithm, and[highWaterMark](https://streams.spec.whatwg.org/#readablestream-set-up-highwatermark) set to 0.
* Let client be transport’s [relevant settings object](https://html.spec.whatwg.org/multipage/webappapis.html#relevant-settings-object).
* Let origin be client’s [origin](https://html.spec.whatwg.org/multipage/webappapis.html#concept-settings-object-origin).
* Let request be a new [request](https://fetch.spec.whatwg.org/#concept-request) whose [URL](https://fetch.spec.whatwg.org/#concept-request-url) is url, [client](https://fetch.spec.whatwg.org/#concept-request-client) isclient, [service-workers mode](https://fetch.spec.whatwg.org/#request-service-workers-mode) is "`none`",[referrer](https://fetch.spec.whatwg.org/#concept-request-referrer) is "`no-referrer`", [mode](https://fetch.spec.whatwg.org/#concept-request-mode) is "`webtransport`",[credentials mode](https://fetch.spec.whatwg.org/#concept-request-credentials-mode) is "`omit`", [cache mode](https://fetch.spec.whatwg.org/#concept-request-cache-mode) is "`no-store`",[policy container](https://fetch.spec.whatwg.org/#concept-request-policy-container) is client’s[policy container](https://html.spec.whatwg.org/multipage/webappapis.html#concept-settings-object-policy-container), [destination](https://fetch.spec.whatwg.org/#concept-request-destination) is "",[origin](https://fetch.spec.whatwg.org/#concept-request-origin) is origin, [WebTransport-hash list](https://fetch.spec.whatwg.org/#request-webtransport-hash-list) isserverCertificateHashes and [redirect mode](https://fetch.spec.whatwg.org/#concept-request-redirect-mode) is "error".  
Note: Redirects are not followed. Network errors caused by redirection are intentionally indistinguishable from other network errors. In cross-origin contexts, this would reveal information that would normally be blocked by CORS. In same-origin contexts, it might encourage applications to abuse the handshake as a vector for passing information.
* Set request’s [method](https://fetch.spec.whatwg.org/#concept-request-method) to "`CONNECT`", and set the method’s associated`:protocol` pseudo-header to `"webtransport"`.
* If protocols is not empty, [set a structured field value](https://fetch.spec.whatwg.org/#concept-header-list-set-structured-header) with (`WT-Available-Protocols`, a[ structured header list](https://html.spec.whatwg.org/#http-structured-header-list) whose members are the[ structured header string](https://html.spec.whatwg.org/#http-structured-header-list) items in protocols in order) in request’s[header list](https://fetch.spec.whatwg.org/#concept-request-header-list).
* [Fetch](https://fetch.spec.whatwg.org/#concept-fetch) request, with [useParallelQueue](https://fetch.spec.whatwg.org/#fetch-useparallelqueue) set to true, and [processResponse](https://fetch.spec.whatwg.org/#process-response) set to the following steps given a response:  
1. [Process a WebTransport fetch response](#process-a-webtransport-fetch-response) with response, origin, protocols, and congestionControl.
* Return transport.

To obtain a WebTransport connection, given a [network partition key](https://fetch.spec.whatwg.org/#network-partition-key) networkPartitionKey, and a [request](https://fetch.spec.whatwg.org/#concept-fetch-record-request) request:
1. Let transport be the `[WebTransport](#webtransport)` object associated with request.
2. Let url be request’s [current URL](https://fetch.spec.whatwg.org/#concept-request-current-url).
3. Let newConnection be transport.`[[[NewConnection]]](#dom-webtransport-newconnection-slot)`.
4. Let requireUnreliable be transport.`[[[RequireUnreliable]]](#dom-webtransport-requireunreliable-slot)`.
5. Let webTransportHashes be the values in request’s [WebTransport-hash list](https://fetch.spec.whatwg.org/#request-webtransport-hash-list).
6. Let connection be the result of [obtaining a connection](https://fetch.spec.whatwg.org/#concept-connection-obtain) withnetworkPartitionKey, url, false, newConnection, requireUnreliable andwebTransportHashes.
7. If connection is failure, return failure.
8. Wait for connection to receive the first SETTINGS frame, and let settings be a dictionary that represents the SETTINGS frame.
9. If settings doesn’t contain `SETTINGS_ENABLE_CONNECT_PROTOCOL` (0x08, see[Section 3](https://datatracker.ietf.org/doc/html/rfc8441#section-3) of [\[RFC8441\]](#biblio-rfc8441 "Bootstrapping WebSockets with HTTP/2") for HTTP/2; 0x08, see [Section 3](https://www.rfc-editor.org/rfc/rfc9220.html#section-3) of[\[RFC9220\]](#biblio-rfc9220 "Bootstrapping WebSockets with HTTP/3")) with a value of 1, then return failure.
10. If settings doesn’t indicate server support for WebTransport, then return failure.[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview#section-4.1-2.2.1).  
   * Over HTTP/3, support requires `SETTINGS_WT_MAX_SESSIONS` with a value above 0, and `SETTINGS_H3_DATAGRAM` with a value of 1\. [\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3") [Section 3.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3/#section-3.1).  
   * Over HTTP/2, potential support is already indicated by `SETTINGS_ENABLE_CONNECT_PROTOCOL` above.[\[WEB-TRANSPORT-HTTP2\]](#biblio-web-transport-http2 "WebTransport over HTTP/2") [Section 3.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http2/#section-3.1).  
Note: `SETTINGS_WT_MAX_SESSIONS` is in flux in the IETF and may change back to`SETTINGS_ENABLE_WEBTRANSPORT`.
11. Return connection.

To process a WebTransport fetch response, given a response, and congestionControl, run these steps:
1. If response is [network error](https://fetch.spec.whatwg.org/#concept-network-error), then abort the remaining steps and [queue a network task](#webtransport-queue-a-network-task) withtransport to run these steps:  
   1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`, then abort these steps.  
   2. Let error be a newly [created](https://heycam.github.io/webidl/#dfn-create-exception) `[WebTransportError](#webtransporterror)` whose`[source](#dom-webtransporterroroptions-source)` is `"session"`.  
   3. [Cleanup](#webtransport-cleanup) transport with error.
2. Let connection be the underlying connection associated with response.
3. Follow any restrictions in [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11#section-4.1-2.2.1) to establish a [WebTransport session](#protocol-webtransport-session) on connection using the server’s response, and let session be the resulting [WebTransport session](#protocol-webtransport-session). The resulting underlying transport stream is referred to as the session’s CONNECT stream.  
Note: This step also concludes the transport parameter exchange specified in [\[QUIC-DATAGRAM\]](#biblio-quic-datagram "An Unreliable Datagram Extension to QUIC").
4. If the previous step fails, abort the remaining steps and [queue a network task](#webtransport-queue-a-network-task) withtransport to run these steps:  
   1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`, then abort these steps.  
   2. Let error be a newly [created](https://heycam.github.io/webidl/#dfn-create-exception) `[WebTransportError](#webtransporterror)` whose`[source](#dom-webtransporterroroptions-source)` is `"session"`.  
   3. [Cleanup](#webtransport-cleanup) transport with error.
5. If the user agent supports more than one congestion control algorithm, choose one appropriate for congestionControl for sending of data on this connection.
6. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
   1. Assert: [this](https://webidl.spec.whatwg.org/#this)’s `[[[Datagrams]]](#dom-webtransport-datagrams-slot)`’s `[[[OutgoingMaxDatagramSize]]](#dom-webtransportdatagramduplexstream-outgoingmaxdatagramsize-slot)` is an integer.  
   2. If transport.`[[[State]]](#dom-webtransport-state-slot)` is not `"connecting"`:  
         1. [In parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel), [terminate](#session-terminate) session.  
         2. Abort these steps.  
   3. Set transport.`[[[State]]](#dom-webtransport-state-slot)` to `"connected"`.  
   4. Set transport.`[[[Session]]](#dom-webtransport-session-slot)` to session.  
   5. Set transport.`[[[Protocol]]](#dom-webtransport-protocol-slot)` to either the string value of the negotiated application protocol if present, following [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 3.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview-11/#section-3.1), or `""` if not present.  
   6. If the connection is an HTTP/3 connection, set transport.`[[[Reliability]]](#dom-webtransport-reliability-slot)` to `"supports-unreliable"`.  
   7. If the connection is an HTTP/2 connection [\[WEB-TRANSPORT-HTTP2\]](#biblio-web-transport-http2 "WebTransport over HTTP/2"), set transport’s `[[[Reliability]]](#dom-webtransport-reliability-slot)` to `"reliable-only"`.  
   8. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) transport.`[[[Ready]]](#dom-webtransport-ready-slot)` with undefined.

To pullBidirectionalStream, given a `[WebTransport](#webtransport)` object transport, run these steps.
1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"connecting"`, then return the result of performing the following steps [upon fulfillment](https://webidl.spec.whatwg.org/#upon-fulfillment) of transport.`[[[Ready]]](#dom-webtransport-ready-slot)`:  
   1. Return the result of [pullBidirectionalStream](#pullbidirectionalstream) with transport.
2. If transport.`[[[State]]](#dom-webtransport-state-slot)` is not `"connected"`, then return a new [rejected](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
3. Let session be transport.`[[[Session]]](#dom-webtransport-session-slot)`.
4. Let p be a new promise.
5. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. Wait until there is an [available incoming bidirectional stream](#session-receive-a-bidirectional-stream) in session.  
   2. Let internalStream be the result of [receiving a bidirectional stream](#session-receive-a-bidirectional-stream) from session.  
   3. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
         1. Let stream be the result of [creating](#bidirectionalstream-create) a`[WebTransportBidirectionalStream](#webtransportbidirectionalstream)` with internalStream and transport.  
         2. [Enqueue](https://streams.spec.whatwg.org/#readablestream-enqueue) stream to transport.`[[[IncomingBidirectionalStreams]]](#dom-webtransport-incomingbidirectionalstreams-slot)`.  
         3. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with undefined.
6. Return p.

To pullUnidirectionalStream, given a `[WebTransport](#webtransport)` object transport, run these steps.
1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"connecting"`, then return the result of performing the following steps [upon fulfillment](https://webidl.spec.whatwg.org/#upon-fulfillment) of transport.`[[[Ready]]](#dom-webtransport-ready-slot)`:  
   1. Return the result of [pullUnidirectionalStream](#pullunidirectionalstream) with transport.
2. If transport.`[[[State]]](#dom-webtransport-state-slot)` is not `"connected"`, then return a new [rejected](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
3. Let session be transport.`[[[Session]]](#dom-webtransport-session-slot)`.
4. Let p be a new promise.
5. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. Wait until there is an[available incoming unidirectional stream](#session-receive-an-incoming-unidirectional-stream) in session.  
   2. Let internalStream be the result of [receiving an incoming unidirectional stream](#session-receive-an-incoming-unidirectional-stream) from session.  
   3. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
         1. Let stream be the result of [creating](#webtransportreceivestream-create) a `[WebTransportReceiveStream](#webtransportreceivestream)` withinternalStream and transport.  
         2. [Enqueue](https://streams.spec.whatwg.org/#readablestream-enqueue) stream to transport.`[[[IncomingUnidirectionalStreams]]](#dom-webtransport-incomingunidirectionalstreams-slot)`.  
         3. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with undefined.
6. Return p.

### 6.3\. Attributes[](#webtransport-attributes)

`ready`,  of type Promise<[undefined](https://webidl.spec.whatwg.org/#idl-undefined)\>, readonly 

On getting, it MUST return [this](https://webidl.spec.whatwg.org/#this)’s `[[[Ready]]](#dom-webtransport-ready-slot)`.

`closed`,  of type Promise<[WebTransportCloseInfo](#dictdef-webtransportcloseinfo)\>, readonly 

On getting, it MUST return [this](https://webidl.spec.whatwg.org/#this)’s `[[[Closed]]](#dom-webtransport-closed-slot)`.

`draining`,  of type Promise<[undefined](https://webidl.spec.whatwg.org/#idl-undefined)\>, readonly 

On getting, it MUST return [this](https://webidl.spec.whatwg.org/#this)’s `[[[Draining]]](#dom-webtransport-draining-slot)`.

`datagrams`,  of type [WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream), readonly 

A single duplex stream for sending and receiving datagrams over this session. The getter steps for the `datagrams` attribute SHALL be:

1. Return [this](https://webidl.spec.whatwg.org/#this)’s `[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.
`incomingBidirectionalStreams`,  of type [ReadableStream](https://streams.spec.whatwg.org/#readablestream), readonly 

Returns a `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)` of `[WebTransportBidirectionalStream](#webtransportbidirectionalstream)`s that have been received from the server.

Note: Whether the incoming streams already have data on them will depend on server behavior.

The getter steps for the `incomingBidirectionalStreams` attribute SHALL be:

1. Return [this](https://webidl.spec.whatwg.org/#this)’s `[[[IncomingBidirectionalStreams]]](#dom-webtransport-incomingbidirectionalstreams-slot)`.
`incomingUnidirectionalStreams`,  of type [ReadableStream](https://streams.spec.whatwg.org/#readablestream), readonly 

A `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)` of unidirectional streams, each represented by a`[WebTransportReceiveStream](#webtransportreceivestream)`, that have been received from the server.

Note: Whether the incoming streams already have data on them will depend on server behavior.

The getter steps for `incomingUnidirectionalStreams` are:

1. Return [this](https://webidl.spec.whatwg.org/#this).`[[[IncomingUnidirectionalStreams]]](#dom-webtransport-incomingunidirectionalstreams-slot)`.
`reliability`,  of type [WebTransportReliabilityMode](#enumdef-webtransportreliabilitymode), readonly 

Whether connection supports unreliable (over UDP) transport or only reliable (over TCP fallback) transport. Returns `"pending"` until a connection has been established. The getter steps are to return [this](https://webidl.spec.whatwg.org/#this)’s `[[[Reliability]]](#dom-webtransport-reliability-slot)`.

`congestionControl`,  of type [WebTransportCongestionControl](#enumdef-webtransportcongestioncontrol), readonly 

The application’s preference, if requested in the constructor, and satisfied by the user agent, for a congestion control algorithm optimized for either throughput or low latency for sending on this connection. If a preference was requested but not satisfied, then the value is `"default"` The getter steps are to return [this](https://webidl.spec.whatwg.org/#this)’s `[[[CongestionControl]]](#dom-webtransport-congestioncontrol-slot)`.

`supportsReliableOnly`,  of type [boolean](https://webidl.spec.whatwg.org/#idl-boolean), readonly 

Returns true if the user agent supports [WebTransport sessions](#protocol-webtransport-session) over exclusively reliable[connections](https://fetch.spec.whatwg.org/#concept-connection), otherwise false.

`anticipatedConcurrentIncomingUnidirectionalStreams`,  of type [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short), nullable 

Optionally lets an application specify the number of concurrently open[incoming unidirectional](#stream-incoming-unidirectional) streams it anticipates the server creating. If not null, the user agent SHOULD attempt to reduce future round-trips by taking`[[[AnticipatedConcurrentIncomingUnidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams-slot)` into consideration in its negotiations with the server.

The getter steps are to return [this](https://webidl.spec.whatwg.org/#this)’s `[[[AnticipatedConcurrentIncomingUnidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams-slot)`.

The setter steps, given value, are to set [this](https://webidl.spec.whatwg.org/#this)’s`[[[AnticipatedConcurrentIncomingUnidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams-slot)` to value.

`anticipatedConcurrentIncomingBidirectionalStreams`,  of type [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short), nullable 

Optionally lets an application specify the number of concurrently open[bidirectional](#stream-bidirectional) streams it anticipates the server creating. If not null, the user agent SHOULD attempt to reduce future round-trips by taking`[[[AnticipatedConcurrentIncomingBidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams-slot)` into consideration in its negotiations with the server.

The getter steps are to return [this](https://webidl.spec.whatwg.org/#this)’s `[[[AnticipatedConcurrentIncomingBidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams-slot)`.

The setter steps, given value, are to set [this](https://webidl.spec.whatwg.org/#this)’s`[[[AnticipatedConcurrentIncomingBidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams-slot)` to value.

Note: Setting `[anticipatedConcurrentIncomingUnidirectionalStreams](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams)` or`[anticipatedConcurrentIncomingBidirectionalStreams](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams)` does not guarantee the application will receive the number of streams it anticipates.

`protocol`,  of type [DOMString](https://webidl.spec.whatwg.org/#idl-DOMString), readonly 

Once a [WebTransport session](#protocol-webtransport-session) has been established and the `[protocols](#dom-webtransportoptions-protocols)` constructor option was used to provide a non-empty array, returns the application-level protocol selected by the server, if any. Otherwise, an empty string. The getter steps are to return [this](https://webidl.spec.whatwg.org/#this)’s `[[[Protocol]]](#dom-webtransport-protocol-slot)`.

### 6.4\. Methods[](#webtransport-methods)

`close(closeInfo)` 

Terminates the [WebTransport session](#protocol-webtransport-session) associated with the WebTransport object.

When close is called, the user agent MUST run the following steps:

1. Let transport be [this](https://webidl.spec.whatwg.org/#this).
2. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`, then abort these steps.
3. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"connecting"`:  
   1. Let error be a newly [created](https://heycam.github.io/webidl/#dfn-create-exception) `[WebTransportError](#webtransporterror)` whose`[source](#dom-webtransporterroroptions-source)` is `"session"`.  
   2. [Cleanup](#webtransport-cleanup) transport with error.  
   3. Abort these steps.
4. Let session be transport.`[[[Session]]](#dom-webtransport-session-slot)`.
5. Let code be closeInfo.`[closeCode](#dom-webtransportcloseinfo-closecode)`.
6. Let reasonString be the maximal [code unit prefix](https://infra.spec.whatwg.org/#code-unit-prefix) ofcloseInfo.`[reason](#dom-webtransportcloseinfo-reason)` where the [length](https://infra.spec.whatwg.org/#byte-sequence-length) of the[UTF-8 encoded](https://encoding.spec.whatwg.org/#utf-8-encode) prefix doesn’t exceed 1024.
7. Let reason be reasonString, [UTF-8 encoded](https://encoding.spec.whatwg.org/#utf-8-encode).
8. [In parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel), [terminate](#session-terminate) session with code and reason.  
Note: This also [aborts sending](#stream-abort-sending) or [aborts receiving](#stream-abort-receiving) on [WebTransport streams](#protocol-webtransport-stream) contained intransport.`[[[SendStreams]]](#dom-webtransport-sendstreams-slot)` and `[[[ReceiveStreams]]](#dom-webtransport-receivestreams-slot)`.
9. [Cleanup](#webtransport-cleanup) transport with `[AbortError](https://webidl.spec.whatwg.org/#aborterror)` and closeInfo.
`getStats()` 

Gathers stats for this `[WebTransport](#webtransport)`’s [underlying connection](#underlying-connection) and reports the result asynchronously.

When getStats is called, the user agent MUST run the following steps:

1. Let transport be [this](https://webidl.spec.whatwg.org/#this).
2. Let p be a new promise.
3. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"failed"`, [reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with an`[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)` and abort these steps.
4. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"connecting"`, wait until it changes.  
   2. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"failed"`, abort these steps after[queueing a network task](#webtransport-queue-a-network-task) with transport to [reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with an`[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.  
   3. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"`, abort these steps after[queueing a network task](#webtransport-queue-a-network-task) with transport to [resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with the most recent stats available for the connection. The exact point at which those stats are collected is [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined).  
   4. Let gatheredStats be the [list](https://infra.spec.whatwg.org/#list) of stats specific to the[underlying connection](#underlying-connection) needed to populate the[dictionary members](https://webidl.spec.whatwg.org/#dfn-dictionary-member) of `[WebTransportConnectionStats](#dictdef-webtransportconnectionstats)` and`[WebTransportDatagramStats](#dictdef-webtransportdatagramstats)` accurately.  
   5. [Queue a network task](#webtransport-queue-a-network-task) with transport to run the following steps:  
         1. Let stats be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportConnectionStats](#dictdef-webtransportconnectionstats)` object.  
         2. Let datagramStats be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportDatagramStats](#dictdef-webtransportdatagramstats)` object.  
         3. Set stats\["`[datagrams](#dom-webtransportconnectionstats-datagrams)`"\] to datagramStats.  
         4. For each [member](https://webidl.spec.whatwg.org/#dfn-dictionary-member) member of stats anddatagramStats that the user agent wishes to expose,[set](https://infra.spec.whatwg.org/#map-set) member to the the corresponding [entry](https://infra.spec.whatwg.org/#map-entry) in gatheredStats.  
         5. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with stats.
5. Return p.
`exportKeyingMaterial(BufferSource label, optional BufferSource context)` 

Exports keying material from a [TLS Keying Material Exporter](https://www.rfc-editor.org/rfc/rfc8446#section-7.3) for the TLS session uniquely associated with this `[WebTransport](#webtransport)`’s [underlying connection](#underlying-connection).

When `exportKeyingMaterial` is called, the user agent MUST run the following steps:

1. Let transport be [this](https://webidl.spec.whatwg.org/#this).
2. Let labelLength be label.[byte length](https://webidl.spec.whatwg.org/#buffersource-byte-length).
3. If labelLength is more than 255, return [a promise rejected with](https://webidl.spec.whatwg.org/#a-promise-rejected-with) a `[RangeError](https://webidl.spec.whatwg.org/#exceptiondef-rangeerror)`.
4. Let contextLength be 0.
5. If context is given, set contextLength to context.[byte length](https://webidl.spec.whatwg.org/#buffersource-byte-length).
6. If contextLength is more than 255, return [a promise rejected with](https://webidl.spec.whatwg.org/#a-promise-rejected-with) a `[RangeError](https://webidl.spec.whatwg.org/#exceptiondef-rangeerror)`.
7. Let p be a new promise.
8. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel), but [abort when](https://infra.spec.whatwg.org/#abort-when) transport’s`[[[State]]](#dom-webtransport-state-slot)` becomes `"closed"` or `"failed"`, and instead[queue a network task](#webtransport-queue-a-network-task) with transport to [reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`:  
   1. Let keyingMaterial be the result of exporting TLS keying material, as defined in [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 4.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview#section-4.1), with labelLength, label, contextLength, and if present, context.  
   2. [Queue a network task](#webtransport-queue-a-network-task) with transport to [resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with keyingMaterial.
9. Return p.
`createBidirectionalStream()` 

Creates a `[WebTransportBidirectionalStream](#webtransportbidirectionalstream)` object for an outgoing bidirectional stream. Note that the mere creation of a stream is not immediately visible to the peer until it is used to send data.

Note: There is no expectation that the server will be aware of the stream until data is sent on it.

 When `createBidirectionalStream` is called, the user agent MUST run the following steps:
1. If [this](https://webidl.spec.whatwg.org/#this).`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`, return a new [rejected](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
2. Let sendGroup be `[options](#dom-webtransport-createbidirectionalstream-options-options)`’s`[sendGroup](#dom-webtransportsendoptions-sendgroup)`.
3. If sendGroup is not null, and sendGroup.`[[[Transport]]](#dom-webtransportsendgroup-transport-slot)` is not [this](https://webidl.spec.whatwg.org/#this), [throw](https://webidl.spec.whatwg.org/#dfn-throw) an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
4. Let sendOrder be `[options](#dom-webtransport-createbidirectionalstream-options-options)`’s`[sendOrder](#dom-webtransportsendoptions-sendorder)`.
5. Let waitUntilAvailable be `[options](#dom-webtransport-createbidirectionalstream-options-options)`’s`[waitUntilAvailable](#dom-webtransportsendstreamoptions-waituntilavailable)`.
6. Let p be a new promise.
7. Let transport be [this](https://webidl.spec.whatwg.org/#this).
8. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel), but [abort when](https://infra.spec.whatwg.org/#abort-when) transport’s`[[[State]]](#dom-webtransport-state-slot)` becomes `"closed"` or `"failed"`, and instead[queue a network task](#webtransport-queue-a-network-task) with transport to [reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`:  
   1. Let streamId be a new stream ID that is valid and unique fortransport.`[[[Session]]](#dom-webtransport-session-slot)`, as defined in [\[QUIC\]](#biblio-quic "QUIC: A UDP-Based Multiplexed and Secure Transport") [Section 19.11](https://www.rfc-editor.org/rfc/rfc9000#section-19.11). If one is not immediately available due to exhaustion, either wait for it to become available if waitUntilAvailable is true, or if waitUntilAvailable is false, abort these steps after [queueing a network task](#webtransport-queue-a-network-task) with transport to [reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with a `[QuotaExceededError](https://webidl.spec.whatwg.org/#quotaexceedederror)`.  
   2. Let internalStream be the result of [creating a bidirectional stream](#session-create-a-bidirectional-stream) withtransport.`[[[Session]]](#dom-webtransport-session-slot)` and streamId.  
   3. [Queue a network task](#webtransport-queue-a-network-task) with transport to run the following steps:  
         1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`,[reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)` and abort these steps.  
         2. Let stream be the result of [creating](#bidirectionalstream-create) a`[WebTransportBidirectionalStream](#webtransportbidirectionalstream)` with internalStream, transport, sendGroup, and sendOrder.  
         3. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with stream.
9. Return p.

`createUnidirectionalStream()` 

Creates a `[WebTransportSendStream](#webtransportsendstream)` for an outgoing unidirectional stream. Note that the mere creation of a stream is not immediately visible to the server until it is used to send data.

Note: There is no expectation that the server will be aware of the stream until data is sent on it.

 When `createUnidirectionalStream()` method is called, the user agent MUST run the following steps:
1. If [this](https://webidl.spec.whatwg.org/#this).`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`, return a new [rejected](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
2. Let sendGroup be `[options](#dom-webtransport-createunidirectionalstream-options-options)`’s`[sendGroup](#dom-webtransportsendoptions-sendgroup)`.
3. If sendGroup is not null, andsendGroup.`[[[Transport]]](#dom-webtransportsendgroup-transport-slot)` is not [this](https://webidl.spec.whatwg.org/#this), [throw](https://webidl.spec.whatwg.org/#dfn-throw) an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
4. Let sendOrder be `[options](#dom-webtransport-createunidirectionalstream-options-options)`’s`[sendOrder](#dom-webtransportsendoptions-sendorder)`.
5. Let waitUntilAvailable be `[options](#dom-webtransport-createunidirectionalstream-options-options)`’s`[waitUntilAvailable](#dom-webtransportsendstreamoptions-waituntilavailable)`.
6. Let p be a new promise.
7. Let transport be [this](https://webidl.spec.whatwg.org/#this).
8. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel), but [abort when](https://infra.spec.whatwg.org/#abort-when) transport’s`[[[State]]](#dom-webtransport-state-slot)` becomes `"closed"` or `"failed"`, and instead[queue a network task](#webtransport-queue-a-network-task) with transport to [reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`:  
   1. Let streamId be a new stream ID that is valid and unique fortransport.`[[[Session]]](#dom-webtransport-session-slot)`, as defined in [\[QUIC\]](#biblio-quic "QUIC: A UDP-Based Multiplexed and Secure Transport") [Section 19.11](https://www.rfc-editor.org/rfc/rfc9000#section-19.11). If one is not immediately available due to exhaustion, either wait for it to become available if waitUntilAvailable is true, or if waitUntilAvailable is false, abort these steps after [queueing a network task](#webtransport-queue-a-network-task) with transport to [reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with a `[QuotaExceededError](https://webidl.spec.whatwg.org/#quotaexceedederror)`.  
   2. Let internalStream be the result of [creating an outgoing unidirectional stream](#session-create-an-outgoing-unidirectional-stream) withtransport.`[[[Session]]](#dom-webtransport-session-slot)` and streamId.  
   3. [Queue a network task](#webtransport-queue-a-network-task) with transport to run the following steps:  
         1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`,[reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)` and abort these steps.  
         2. Let stream be the result of [creating](#webtransportsendstream-create) a `[WebTransportSendStream](#webtransportsendstream)` withinternalStream, transport, sendGroup, and sendOrder.  
         3. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with stream.
9. return p.

`createSendGroup()` 

Creates a `[WebTransportSendGroup](#webtransportsendgroup)`.

 When `createSendGroup()` method is called, the user agent MUST run the following steps:
1. If [this](https://webidl.spec.whatwg.org/#this).`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`,[throw](https://webidl.spec.whatwg.org/#dfn-throw) an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
2. Return the result of [creating](#webtransportsendgroup-create) a `[WebTransportSendGroup](#webtransportsendgroup)` with [this](https://webidl.spec.whatwg.org/#this).

### 6.5\. Procedures[](#webtransport-procedures)

To cleanup a `[WebTransport](#webtransport)` transport with error and optionally closeInfo, run these steps:
1. Let sendStreams be a copy of transport.`[[[SendStreams]]](#dom-webtransport-sendstreams-slot)`.
2. Let receiveStreams be a copy of transport.`[[[ReceiveStreams]]](#dom-webtransport-receivestreams-slot)`.
3. Let outgoingDatagramWritables be transport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[Writables]]](#dom-webtransportdatagramduplexstream-writables-slot)`.
4. Let incomingDatagrams be transport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`.
5. Let ready be transport.`[[[Ready]]](#dom-webtransport-ready-slot)`.
6. Let closed be transport.`[[[Closed]]](#dom-webtransport-closed-slot)`.
7. Let incomingBidirectionalStreams be transport.`[[[IncomingBidirectionalStreams]]](#dom-webtransport-incomingbidirectionalstreams-slot)`.
8. Let incomingUnidirectionalStreams be transport.`[[[IncomingUnidirectionalStreams]]](#dom-webtransport-incomingunidirectionalstreams-slot)`.
9. Set transport.`[[[SendStreams]]](#dom-webtransport-sendstreams-slot)` to an empty [set](https://infra.spec.whatwg.org/#ordered-set).
10. Set transport.`[[[ReceiveStreams]]](#dom-webtransport-receivestreams-slot)` to an empty [set](https://infra.spec.whatwg.org/#ordered-set).
11. Set transport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[OutgoingDatagramsQueue]]](#dom-webtransportdatagramswritable-outgoingdatagramsqueue-slot)` to an empty [queue](https://infra.spec.whatwg.org/#queue).
12. Set transport.`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[IncomingDatagramsQueue]]](#dom-webtransportdatagramduplexstream-incomingdatagramsqueue-slot)` to an empty [queue](https://infra.spec.whatwg.org/#queue).
13. If closeInfo is given, then set transport.`[[[State]]](#dom-webtransport-state-slot)` to `"closed"`. Otherwise, set transport.`[[[State]]](#dom-webtransport-state-slot)` to `"failed"`.
14. [For each](https://infra.spec.whatwg.org/#list-iterate) stream in sendStreams, run the following steps:  
   1. If stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` is not null, reject stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` with error.  
   2. [Error](https://streams.spec.whatwg.org/#writablestream-error) stream with error.
15. [For each](https://infra.spec.whatwg.org/#list-iterate) stream in receiveStreams, [error](https://streams.spec.whatwg.org/#readablestream-error) stream with error.  
Note: Script authors can inject code which runs in Promise resolution synchronously. Hence from here, do not touch transport as it may be mutated by scripts in an unpredictable way. This applies to logic calling this procedure, too.
16. If closeInfo is given, then:  
   1. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) closed with closeInfo.  
   2. Assert: ready is [settled](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects).  
   3. [Close](https://streams.spec.whatwg.org/#readablestream-close) incomingBidirectionalStreams.  
   4. [Close](https://streams.spec.whatwg.org/#readablestream-close) incomingUnidirectionalStreams.  
   5. For each writable in outgoingDatagramWritables, [close](https://streams.spec.whatwg.org/#writablestream-close) writable.  
   6. [Close](https://streams.spec.whatwg.org/#readablestream-close) incomingDatagrams.
17. Otherwise:  
   1. [Reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) closed with error.  
   2. Set closed.`[[PromiseIsHandled]]` to true.  
   3. [Reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) ready with error.  
   4. Set ready.`[[PromiseIsHandled]]` to true.  
   5. [Error](https://streams.spec.whatwg.org/#readablestream-error) incomingBidirectionalStreams with error.  
   6. [Error](https://streams.spec.whatwg.org/#readablestream-error) incomingUnidirectionalStreams with error.  
   7. For each writable in outgoingDatagramWritables, [error](https://streams.spec.whatwg.org/#writablestream-error) writable with error.  
   8. [Error](https://streams.spec.whatwg.org/#readablestream-error) incomingDatagrams with error.

To queue a network task with a `[WebTransport](#webtransport)` transport and a series of steps steps, run these steps:

1. [Queue a global task](https://html.spec.whatwg.org/multipage/webappapis.html#queue-a-global-task) on the [network task source](https://html.spec.whatwg.org/multipage/webappapis.html#networking-task-source) with transport’s[relevant global object](https://html.spec.whatwg.org/multipage/webappapis.html#concept-relevant-global) to run steps.

### 6.6\. Session termination not initiated by the client[](#web-transport-termination)

Whenever a [WebTransport session](#protocol-webtransport-session) which is associated with a `[WebTransport](#webtransport)` transport is[terminated](#session-terminated) with optionally code and reasonBytes, run these steps:
1. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
   1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`, abort these steps.  
   2. Let error be a newly [created](https://heycam.github.io/webidl/#dfn-create-exception) `[WebTransportError](#webtransporterror)` whose`[source](#dom-webtransporterroroptions-source)` is `"session"`.  
   3. Let closeInfo be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportCloseInfo](#dictdef-webtransportcloseinfo)`.  
   4. If code is given, set closeInfo’s `[closeCode](#dom-webtransportcloseinfo-closecode)` to code.  
   5. If reasonBytes is given, set closeInfo’s `[reason](#dom-webtransportcloseinfo-reason)` to reasonBytes,[UTF-8 decoded](https://encoding.spec.whatwg.org/#utf-8-decode).  
   Note: No language or direction metadata is available with reasonBytes.[First-strong](https://www.w3.org/TR/string-meta/#firststrong) heuristics can be used for direction when displaying the value.  
   6. [Cleanup](#webtransport-cleanup) transport with error and closeInfo.

Whenever a `[WebTransport](#webtransport)` transport’s [underlying connection](#underlying-connection) gets a connection error, run these steps:
1. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
   1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`, abort these steps.  
   2. Let error be a newly [created](https://heycam.github.io/webidl/#dfn-create-exception) `[WebTransportError](#webtransporterror)` whose`[source](#dom-webtransporterroroptions-source)` is `"session"`.  
   3. [Cleanup](#webtransport-cleanup) transport with error.

### 6.7\. Context cleanup steps[](#web-transport-context-cleanup-steps)

This specification defines context cleanup steps as the following steps, given`[WebTransport](#webtransport)` transport:

1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"connected"`, then:  
   1. Set transport.`[[[State]]](#dom-webtransport-state-slot)` to `"failed"`.  
   2. [In parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel), [terminate](#session-terminate) transport.`[[[Session]]](#dom-webtransport-session-slot)`.  
   3. [Queue a network task](#webtransport-queue-a-network-task) with transport to run the following steps:  
         1. Let error be a newly [created](https://heycam.github.io/webidl/#dfn-create-exception) `[WebTransportError](#webtransporterror)` whose`[source](#dom-webtransporterroroptions-source)` is `"session"`.  
         2. [Cleanup](#webtransport-cleanup) transport with error.
2. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"connecting"`, set transport.`[[[State]]](#dom-webtransport-state-slot)` to`"failed"`.  
[](#issue-c18b6608) This needs to be done in workers too. See[#127](https://www.github.com/w3c/webtransport/issues/127) and[whatwg/html#6731](https://www.github.com/whatwg/html/issues/6831).

### 6.8\. Garbage Collection[](#web-transport-gc)

A `[WebTransport](#webtransport)` object whose `[[[State]]](#dom-webtransport-state-slot)` is `"connecting"` must not be garbage collected if`[[[IncomingBidirectionalStreams]]](#dom-webtransport-incomingbidirectionalstreams-slot)`, `[[[IncomingUnidirectionalStreams]]](#dom-webtransport-incomingunidirectionalstreams-slot)`, any`[WebTransportReceiveStream](#webtransportreceivestream)`, or `[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`are [locked](https://streams.spec.whatwg.org/#readablestream-locked), or if the `[ready](#dom-webtransport-ready)`, `[draining](#dom-webtransport-draining)`, or `[closed](#dom-webtransport-closed)` promise is being observed.

A `[WebTransport](#webtransport)` object whose `[[[State]]](#dom-webtransport-state-slot)` is `"connected"` must not be garbage collected if`[[[IncomingBidirectionalStreams]]](#dom-webtransport-incomingbidirectionalstreams-slot)`, `[[[IncomingUnidirectionalStreams]]](#dom-webtransport-incomingunidirectionalstreams-slot)`, any`[WebTransportReceiveStream](#webtransportreceivestream)`, or `[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`are [locked](https://streams.spec.whatwg.org/#readablestream-locked), or if the `[draining](#dom-webtransport-draining)` or `[closed](#dom-webtransport-closed)` promise is being observed.

A `[WebTransport](#webtransport)` object whose `[[[State]]](#dom-webtransport-state-slot)` is `"draining"` must not be garbage collected if`[[[IncomingBidirectionalStreams]]](#dom-webtransport-incomingbidirectionalstreams-slot)`, `[[[IncomingUnidirectionalStreams]]](#dom-webtransport-incomingunidirectionalstreams-slot)`, any`[WebTransportReceiveStream](#webtransportreceivestream)`, or `[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[Readable]]](#dom-webtransportdatagramduplexstream-readable-slot)`are [locked](https://streams.spec.whatwg.org/#readablestream-locked), or if the `[closed](#dom-webtransport-closed)` promise is being observed.

A `[WebTransport](#webtransport)` object with an [established](#session-establish) [WebTransport session](#protocol-webtransport-session)that has data queued to be transmitted to the network, including datagrams in`[[[Datagrams]]](#dom-webtransport-datagrams-slot)`.`[[[OutgoingDatagramsQueue]]](#dom-webtransportdatagramswritable-outgoingdatagramsqueue-slot)`, must not be garbage collected.

If a `[WebTransport](#webtransport)` object is garbage collected while the [underlying connection](#underlying-connection)is still open, the user agent must[terminate the WebTransport session](https://www.ietf.org/archive/id/draft-ietf-webtrans-overview-11.html#section-4.1-2.4.1)with an Application Error Code of `0` and Application Error Message of `""`.

### 6.9\. Configuration[](#web-transport-configuration)

dictionary `WebTransportHash` {
  required [DOMString](https://webidl.spec.whatwg.org/#idl-DOMString) `algorithm`;
  required [BufferSource](https://webidl.spec.whatwg.org/#BufferSource) `value`;
};

dictionary [WebTransportOptions](#dictdef-webtransportoptions) {
  [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [allowPooling](#dom-webtransportoptions-allowpooling) = false;
  [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [requireUnreliable](#dom-webtransportoptions-requireunreliable) = false;
  [sequence](https://webidl.spec.whatwg.org/#idl-sequence)<[WebTransportHash](#dictdef-webtransporthash)> [serverCertificateHashes](#dom-webtransportoptions-servercertificatehashes) = [];
  [WebTransportCongestionControl](#enumdef-webtransportcongestioncontrol) [congestionControl](#dom-webtransportoptions-congestioncontrol) = "default";
  [[EnforceRange](https://webidl.spec.whatwg.org/#EnforceRange)] [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short)? [anticipatedConcurrentIncomingUnidirectionalStreams](#dom-webtransportoptions-anticipatedconcurrentincomingunidirectionalstreams) = null;
  [[EnforceRange](https://webidl.spec.whatwg.org/#EnforceRange)] [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short)? [anticipatedConcurrentIncomingBidirectionalStreams](#dom-webtransportoptions-anticipatedconcurrentincomingbidirectionalstreams) = null;
  [sequence](https://webidl.spec.whatwg.org/#idl-sequence)<[DOMString](https://webidl.spec.whatwg.org/#idl-DOMString)> [protocols](#dom-webtransportoptions-protocols) = [];
  [ReadableStreamType](https://streams.spec.whatwg.org/#enumdef-readablestreamtype) [datagramsReadableType](#dom-webtransportoptions-datagramsreadabletype);
};

enum `WebTransportCongestionControl` {
  `"default"`,
  `"throughput"`,
  `"low-latency"`,
};

`WebTransportOptions` is a dictionary of parameters that determine how the [WebTransport session](#protocol-webtransport-session) is established and used.

`allowPooling`,  of type [boolean](https://webidl.spec.whatwg.org/#idl-boolean), defaulting to `false` 

When set to true, the [WebTransport session](#protocol-webtransport-session) can be pooled, that is, its [underlying connection](#underlying-connection) can be shared with other WebTransport sessions.

`requireUnreliable`,  of type [boolean](https://webidl.spec.whatwg.org/#idl-boolean), defaulting to `false` 

When set to true, the [WebTransport session](#protocol-webtransport-session) cannot be established over an HTTP/2 [connection](https://fetch.spec.whatwg.org/#concept-connection) if an HTTP/3 [connection](https://fetch.spec.whatwg.org/#concept-connection) is not possible.

`serverCertificateHashes`,  of type sequence<[WebTransportHash](#dictdef-webtransporthash)\>, defaulting to `[]` 

This option is only supported for transports using dedicated connections. For transport protocols that do not support this feature, having this field non-empty SHALL result in a `[NotSupportedError](https://webidl.spec.whatwg.org/#notsupportederror)` exception being thrown.

If supported and non-empty, the user agent SHALL deem a server certificate trusted if and only if it can successfully [verify a certificate hash](#verify-a-certificate-hash) against`[serverCertificateHashes](#dom-webtransportoptions-servercertificatehashes)` and satisfies [custom certificate requirements](#custom-certificate-requirements). The user agent SHALL ignore any hash that uses an unknown `[algorithm](#dom-webtransporthash-algorithm)`. If [empty](https://infra.spec.whatwg.org/#list-is-empty), the user agent SHALL use certificate verification procedures it would use for normal [fetch](https://fetch.spec.whatwg.org/#concept-fetch) operations.

This cannot be used with `[allowPooling](#dom-webtransportoptions-allowpooling)`.

`congestionControl`,  of type [WebTransportCongestionControl](#enumdef-webtransportcongestioncontrol), defaulting to `"default"` 

Optionally specifies an application’s preference for a congestion control algorithm tuned for either throughput or low-latency to be used when sending data over this connection. This is a hint to the user agent.

[](#issue-398c2337) 

 This configuration option is considered a feature at risk due to the lack of implementation in browsers of a congestion control algorithm, at the time of writing, that optimizes for low latency.

`anticipatedConcurrentIncomingUnidirectionalStreams`,  of type [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short), nullable, defaulting to `null` 

Optionally lets an application specify the number of concurrently open[incoming unidirectional](#stream-incoming-unidirectional) streams it anticipates the server creating. The user agent MUST initially allow at least 100 [incoming unidirectional](#stream-incoming-unidirectional) streams from the server. If not null, the user agent SHOULD attempt to reduce round-trips by taking`[[[AnticipatedConcurrentIncomingUnidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams-slot)` into consideration in its negotiations with the server.

`anticipatedConcurrentIncomingBidirectionalStreams`,  of type [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short), nullable, defaulting to `null` 

Optionally lets an application specify the number of concurrently open[bidirectional](#stream-bidirectional) streams it anticipates a server creating. The user agent MUST initially allow the server to create at least 100[bidirectional](#stream-bidirectional) streams. If not null, the user agent SHOULD attempt to reduce round-trips by taking`[[[AnticipatedConcurrentIncomingBidirectionalStreams]]](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams-slot)` into consideration in its negotiations with the server.

`protocols`,  of type sequence<[DOMString](https://webidl.spec.whatwg.org/#idl-DOMString)\>, defaulting to `[]` 

An optionally provided array of application-level protocol names. Selecting a preferred application-protocol and communicating it to the client is optional for the server. Servers might reject the request if a suitable protocol was not provided.

`datagramsReadableType`,  of type [ReadableStreamType](https://streams.spec.whatwg.org/#enumdef-readablestreamtype) 

Optionally specifies an application’s preference for using a[readable byte stream](https://streams.spec.whatwg.org/#readable-byte-stream) for incoming datagrams. Otherwise, a default [readable stream](https://streams.spec.whatwg.org/#readable-stream) is used.

Note: While [readable stream](https://streams.spec.whatwg.org/#readable-stream) is compatible with datagram semantics,[readable byte stream](https://streams.spec.whatwg.org/#readable-byte-stream) is not. Datagrams are differentiated messages of zero or more bytes, that can arrive out of order, not an undifferentiated byte sequence. Empty datagrams are lost, and`[min](https://streams.spec.whatwg.org/#dom-readablestreambyobreaderreadoptions-min)` loses message delineation.

To compute a certificate hash, given a certificate, perform the following steps:
1. Let cert be certificate, represented as a DER encoding of Certificate message defined in [\[RFC5280\]](#biblio-rfc5280 "Internet X.509 Public Key Infrastructure Certificate and Certificate Revocation List (CRL) Profile").
2. Compute the SHA-256 hash of cert and return the computed value.

To verify a certificate hash, given a certificate chain and an array of hashes hashes, perform the following steps:
1. Let certificate be the first certificate in certificate chain (the leaf certificate).
2. Let referenceHash be the result of [computing a certificate hash](#compute-a-certificate-hash) with certificate.
3. For every hash hash in hashes:  
   1. If hash.`[value](#dom-webtransporthash-value)` is not null and hash.`[algorithm](#dom-webtransporthash-algorithm)` is an [ASCII case-insensitive](https://infra.spec.whatwg.org/#ascii-case-insensitive) match with "sha-256":  
         1. Let hashValue be the byte sequence which hash.`[value](#dom-webtransporthash-value)` represents.  
         2. If hashValue is equal to referenceHash, return true.
4. Return false.

The custom certificate requirements are as follows: the certificate MUST be an X.509v3 certificate as defined in [\[RFC5280\]](#biblio-rfc5280 "Internet X.509 Public Key Infrastructure Certificate and Certificate Revocation List (CRL) Profile"), the key used in the Subject Public Key field MUST be one of the [allowed public key algorithms](#allowed-public-key-algorithms), the current time MUST be within the validity period of the certificate as defined in Section 4.1.2.5 of [\[RFC5280\]](#biblio-rfc5280 "Internet X.509 Public Key Infrastructure Certificate and Certificate Revocation List (CRL) Profile") and the total length of the validity period MUST NOT exceed two weeks. The user agent MAY impose additional[implementation-defined](https://infra.spec.whatwg.org/#implementation-defined) requirements on the certificate.

The exact list of allowed public key algorithms used in the Subject Public Key Info field (and, as a consequence, in the TLS CertificateVerify message) is [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined); however, it MUST include ECDSA with the secp256r1 (NIST P-256) named group ([\[RFC3279\]](#biblio-rfc3279 "Algorithms and Identifiers for the Internet X.509 Public Key Infrastructure Certificate and Certificate Revocation List (CRL) Profile"), Section 2.3.5; [\[RFC8422\]](#biblio-rfc8422 "Elliptic Curve Cryptography (ECC) Cipher Suites for Transport Layer Security (TLS) Versions 1.2 and Earlier")) to provide an interoperable default. It MUST NOT contain RSA keys ([\[RFC3279\]](#biblio-rfc3279 "Algorithms and Identifiers for the Internet X.509 Public Key Infrastructure Certificate and Certificate Revocation List (CRL) Profile"), Section 2.3.1).

### 6.10\. `WebTransportCloseInfo` Dictionary[](#web-transport-close-info)

The `WebTransportCloseInfo` dictionary includes information used to set the error code and reason when [terminating](#session-terminate)a [WebTransport session](#protocol-webtransport-session).

dictionary [WebTransportCloseInfo](#dictdef-webtransportcloseinfo) {
  [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long) [closeCode](#dom-webtransportcloseinfo-closecode) = 0;
  [USVString](https://webidl.spec.whatwg.org/#idl-USVString) [reason](#dom-webtransportcloseinfo-reason) = "";
};

The dictionary SHALL have the following attributes:

`closeCode`,  of type [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long), defaulting to `0` 

The error code communicated to the peer.

`reason`,  of type [USVString](https://webidl.spec.whatwg.org/#idl-USVString), defaulting to `""` 

The reason for closing the `[WebTransport](#webtransport)`.

### 6.11\. `WebTransportSendOptions` Dictionary[](#send-options)

The `WebTransportSendOptions` is a base dictionary of parameters that affect how `[createUnidirectionalStream](#dom-webtransport-createunidirectionalstream)`,`[createBidirectionalStream](#dom-webtransport-createbidirectionalstream)`, and the`[createWritable](#dom-webtransportdatagramduplexstream-createwritable)` methods behave.

dictionary [WebTransportSendOptions](#dictdef-webtransportsendoptions) {
  [WebTransportSendGroup](#webtransportsendgroup)? [sendGroup](#dom-webtransportsendoptions-sendgroup) = null;
  [long long](https://webidl.spec.whatwg.org/#idl-long-long) [sendOrder](#dom-webtransportsendoptions-sendorder) = 0;
};

The dictionary SHALL have the following attributes:

`sendGroup`,  of type [WebTransportSendGroup](#webtransportsendgroup), nullable, defaulting to `null` 

An optional `[WebTransportSendGroup](#webtransportsendgroup)` to [group](#grouped) the created stream under, or null.

`sendOrder`,  of type [long long](https://webidl.spec.whatwg.org/#idl-long-long), defaulting to `0` 

A send order number that, if provided, opts the created stream in to participating in strict ordering. Bytes currently queued on [strictly ordered](#strict-ordering) streams will be sent ahead of bytes currently queued on other [strictly ordered](#strict-ordering) streams created with lower send order numbers.

If no send order number is provided, then the order in which the user agent sends bytes from it relative to other streams is [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined). User agents are strongly encouraged however to divide bandwidth fairly between all streams that aren’t starved by lower send order numbers.

Note: This is sender-side data prioritization which does not guarantee reception order.

### 6.12\. `WebTransportSendStreamOptions` Dictionary[](#uni-stream-options)

The `WebTransportSendStreamOptions` is a dictionary of parameters that affect how `[WebTransportSendStream](#webtransportsendstream)`s created by`[createUnidirectionalStream](#dom-webtransport-createunidirectionalstream)` and`[createBidirectionalStream](#dom-webtransport-createbidirectionalstream)` behave.

dictionary [WebTransportSendStreamOptions](#dictdef-webtransportsendstreamoptions) : [WebTransportSendOptions](#dictdef-webtransportsendoptions) {
  [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [waitUntilAvailable](#dom-webtransportsendstreamoptions-waituntilavailable) = false;
};

The dictionary SHALL have the following attributes:

`waitUntilAvailable`,  of type [boolean](https://webidl.spec.whatwg.org/#idl-boolean), defaulting to `false` 

If true, the promise returned by the`[createUnidirectionalStream](#dom-webtransport-createunidirectionalstream)` or`[createBidirectionalStream](#dom-webtransport-createbidirectionalstream)` call will not be [settled](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) until either the [underlying connection](#underlying-connection) has sufficient flow control credit to create the stream, or the connection reaches a state in which no further outgoing streams are possible. If false, the promise will be[rejected](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) if no flow control window is available at the time of the call.

### 6.13\. `WebTransportConnectionStats` Dictionary[](#web-transport-connection-stats)

The `WebTransportConnectionStats` dictionary includes information on WebTransport-specific stats about the [WebTransport session](#protocol-webtransport-session)’s [underlying connection](#underlying-connection).

Note: When pooling is used, multiple [WebTransport sessions](#protocol-webtransport-session) pooled on the same [connection](https://fetch.spec.whatwg.org/#concept-connection) all receive the same information, i.e. the information is disclosed across pooled [ sessions](#protocol-webtransport-session) holding the same [network partition key](https://fetch.spec.whatwg.org/#network-partition-keys).

Note: Any unavailable stats will be [absent](https://infra.spec.whatwg.org/#map-exists) from the `[WebTransportConnectionStats](#dictdef-webtransportconnectionstats)` dictionary.

dictionary [WebTransportConnectionStats](#dictdef-webtransportconnectionstats) {
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesSent](#dom-webtransportconnectionstats-bytessent);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesSentOverhead](#dom-webtransportconnectionstats-bytessentoverhead);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesAcknowledged](#dom-webtransportconnectionstats-bytesacknowledged);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [packetsSent](#dom-webtransportconnectionstats-packetssent);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesLost](#dom-webtransportconnectionstats-byteslost);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [packetsLost](#dom-webtransportconnectionstats-packetslost);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesReceived](#dom-webtransportconnectionstats-bytesreceived);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [packetsReceived](#dom-webtransportconnectionstats-packetsreceived);
  [DOMHighResTimeStamp](https://w3c.github.io/hr-time/#dom-domhighrestimestamp) [smoothedRtt](#dom-webtransportconnectionstats-smoothedrtt);
  [DOMHighResTimeStamp](https://w3c.github.io/hr-time/#dom-domhighrestimestamp) [rttVariation](#dom-webtransportconnectionstats-rttvariation);
  [DOMHighResTimeStamp](https://w3c.github.io/hr-time/#dom-domhighrestimestamp) [minRtt](#dom-webtransportconnectionstats-minrtt);
  required [WebTransportDatagramStats](#dictdef-webtransportdatagramstats) `datagrams`;
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long)? [estimatedSendRate](#dom-webtransportconnectionstats-estimatedsendrate) = null;
  [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [atSendCapacity](#dom-webtransportconnectionstats-atsendcapacity) = false;
};

The dictionary SHALL have the following attributes:

`bytesSent`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of payload bytes sent over the [underlying connection](#underlying-connection), excluding any framing overhead or retransmissions.

`bytesSentOverhead`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The framing and retransmission overhead in bytes of sending`[bytesSent](#dom-webtransportconnectionstats-bytessent)` number of payload bytes on the[underlying connection](#underlying-connection).

`bytesAcknowledged`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of payload bytes acknowledged as received by the server using QUIC’s ACK mechanism on the [underlying connection](#underlying-connection). Excludes any framing.

Note: Typically trails `[bytesSent](#dom-webtransportconnectionstats-bytessent)` but can be permanently less due to packet loss.

[](#issue-6431e51e) `[bytesAcknowledged](#dom-webtransportconnectionstats-bytesacknowledged)` on `[WebTransportConnectionStats](#dictdef-webtransportconnectionstats)` has been identified by the Working Group as a feature at risk due to concerns over implementability.

`packetsSent`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of packets sent on the [underlying connection](#underlying-connection), including those that are determined to have been lost.

`bytesLost`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of bytes lost on the [underlying connection](#underlying-connection) (does not monotonically increase, because packets that are declared lost can subsequently be received). Does not include UDP or any other outer framing.

`packetsLost`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of packets lost on the [underlying connection](#underlying-connection) (does not monotonically increase, because packets that are declared lost can subsequently be received).

`bytesReceived`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of total bytes received on the [underlying connection](#underlying-connection), including duplicate data for streams. Does not include UDP or any other outer framing.

`packetsReceived`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of total packets received on the [underlying connection](#underlying-connection), including packets that were not processable.

`smoothedRtt`,  of type [DOMHighResTimeStamp](https://w3c.github.io/hr-time/#dom-domhighrestimestamp) 

The smoothed round-trip time (RTT) currently observed on the connection, as defined in [\[RFC9002\]](#biblio-rfc9002 "QUIC Loss Detection and Congestion Control") [Section 5.3](https://www.rfc-editor.org/rfc/rfc9002#section-5.3).

`rttVariation`,  of type [DOMHighResTimeStamp](https://w3c.github.io/hr-time/#dom-domhighrestimestamp) 

The mean variation in round-trip time samples currently observed on the connection, as defined in [\[RFC9002\]](#biblio-rfc9002 "QUIC Loss Detection and Congestion Control") [Section 5.3](https://www.rfc-editor.org/rfc/rfc9002#section-5.3).

`minRtt`,  of type [DOMHighResTimeStamp](https://w3c.github.io/hr-time/#dom-domhighrestimestamp) 

The minimum round-trip time observed on the entire connection, as defined in[\[RFC9002\]](#biblio-rfc9002 "QUIC Loss Detection and Congestion Control") [Section 5.2](https://www.rfc-editor.org/rfc/rfc9002#section-5.2).

`estimatedSendRate`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long), nullable, defaulting to `null` 

The estimated rate at which queued data will be sent by the user agent, in bits per second. This rate applies to all streams and datagrams that share a [WebTransport session](#protocol-webtransport-session) and is calculated by the congestion control algorithm (potentially chosen by`[congestionControl](#dom-webtransport-congestioncontrol)`). This estimate excludes any framing overhead and represents the rate at which an application payload might be sent. If the user agent does not currently have an estimate, the member MUST be the `null` value. The member can be `null` even if it was not `null` in previous results.

`atSendCapacity`,  of type [boolean](https://webidl.spec.whatwg.org/#idl-boolean), defaulting to `false` 

A value of false indicates the `[estimatedSendRate](#dom-webtransportconnectionstats-estimatedsendrate)` might be application limited, meaning the application is sending significantly less data than the congestion controller allows. A congestion controller might produce a poor estimate of the available network capacity while it is application limited.

A value of true indicates the application is sending data at network capacity, and the `[estimatedSendRate](#dom-webtransportconnectionstats-estimatedsendrate)` reflects the network capacity available to the application.

 When `[atSendCapacity](#dom-webtransportconnectionstats-atsendcapacity)` is `true`, the `[estimatedSendRate](#dom-webtransportconnectionstats-estimatedsendrate)` reflects a ceiling. As long as the application send rate is sustained, the `[estimatedSendRate](#dom-webtransportconnectionstats-estimatedsendrate)` will adapt to network conditions. However, `[estimatedSendRate](#dom-webtransportconnectionstats-estimatedsendrate)` is allowed to be `null` while`[atSendCapacity](#dom-webtransportconnectionstats-atsendcapacity)` is true.

### 6.14\. `WebTransportDatagramStats` Dictionary[](#web-transport-datagram-stats)

The `WebTransportDatagramStats` dictionary includes statistics on datagram transmission over the [underlying connection](#underlying-connection).

dictionary [WebTransportDatagramStats](#dictdef-webtransportdatagramstats) {
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [droppedIncoming](#dom-webtransportdatagramstats-droppedincoming);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [expiredIncoming](#dom-webtransportdatagramstats-expiredincoming);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [expiredOutgoing](#dom-webtransportdatagramstats-expiredoutgoing);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [lostOutgoing](#dom-webtransportdatagramstats-lostoutgoing);
};

The dictionary SHALL have the following attributes:

`droppedIncoming`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of incoming datagrams that were dropped due to the application not reading from `[datagrams](#dom-webtransport-datagrams)`' `[readable](#dom-webtransportdatagramduplexstream-readable)`before new datagrams overflow the receive queue.

`expiredIncoming`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of incoming datagrams that were dropped due to being older than`[incomingMaxAge](#dom-webtransportdatagramduplexstream-incomingmaxage)` before they were read from `[datagrams](#dom-webtransport-datagrams)`'`[readable](#dom-webtransportdatagramduplexstream-readable)`.

`expiredOutgoing`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of datagrams queued for sending that were dropped due to being older than `[outgoingMaxAge](#dom-webtransportdatagramduplexstream-outgoingmaxage)` before they were able to be sent.

`lostOutgoing`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The number of sent datagrams that were declared lost, as defined in[\[RFC9002\]](#biblio-rfc9002 "QUIC Loss Detection and Congestion Control") [Section 6.1](https://www.rfc-editor.org/rfc/rfc9002#section-6.1).

## 7\. Interface `WebTransportSendStream`[](#send-stream)

A `[WebTransportSendStream](#webtransportsendstream)` is a `[WritableStream](https://streams.spec.whatwg.org/#writablestream)` providing outgoing streaming features with an [outgoing unidirectional](#stream-outgoing-unidirectional) or [bidirectional](#stream-bidirectional) [WebTransport stream](#protocol-webtransport-stream).

It is a `[WritableStream](https://streams.spec.whatwg.org/#writablestream)` of `[Uint8Array](https://webidl.spec.whatwg.org/#idl-Uint8Array)` that can be written to, to send data to the server.

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext), [Transferable](https://html.spec.whatwg.org/multipage/structured-data.html#transferable)]
interface `WebTransportSendStream` : [WritableStream](https://streams.spec.whatwg.org/#writablestream) {
  attribute [WebTransportSendGroup](#webtransportsendgroup)? [sendGroup](#dom-webtransportsendstream-sendgroup);
  attribute [long long](https://webidl.spec.whatwg.org/#idl-long-long) [sendOrder](#dom-webtransportsendstream-sendorder);
  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats)> [getStats](#dom-webtransportsendstream-getstats)();
  [WebTransportWriter](#webtransportwriter) [getWriter](#dom-webtransportsendstream-getwriter)();
};

A `[WebTransportSendStream](#webtransportsendstream)` is always created by the[create](#webtransportsendstream-create) procedure.

The `[WebTransportSendStream](#webtransportsendstream)`’s [transfer steps](https://html.spec.whatwg.org/multipage/structured-data.html#transfer-steps) and[transfer-receiving steps](https://html.spec.whatwg.org/multipage/structured-data.html#transfer-receiving-steps) are[those of](https://streams.spec.whatwg.org/#ws-transfer) `[WritableStream](https://streams.spec.whatwg.org/#writablestream)`.

### 7.1\. Attributes[](#send-stream-attributes)

`sendGroup`,  of type [WebTransportSendGroup](#webtransportsendgroup), nullable 

The getter steps are:

1. Return [this](https://webidl.spec.whatwg.org/#this)’s `[[[SendGroup]]](#dom-webtransportsendstream-sendgroup-slot)`.

The setter steps, given value, are:

1. If value is non-null, andvalue.`[[[Transport]]](#dom-webtransportsendgroup-transport-slot)` is not[this](https://webidl.spec.whatwg.org/#this).`[[[Transport]]](#dom-webtransportsendstream-transport-slot)`, [throw](https://webidl.spec.whatwg.org/#dfn-throw) an `[InvalidStateError](https://webidl.spec.whatwg.org/#invalidstateerror)`.
2. Set [this](https://webidl.spec.whatwg.org/#this).`[[[SendGroup]]](#dom-webtransportsendstream-sendgroup-slot)` to value.
`sendOrder`,  of type [long long](https://webidl.spec.whatwg.org/#idl-long-long) 

The getter steps are:

1. Return [this](https://webidl.spec.whatwg.org/#this)’s `[[[SendOrder]]](#dom-webtransportsendstream-sendorder-slot)`.

The setter steps, given value, are:

1. Set [this](https://webidl.spec.whatwg.org/#this).`[[[SendOrder]]](#dom-webtransportsendstream-sendorder-slot)` to value.

### 7.2\. Methods[](#send-stream-methods)

`getStats()` 

Gathers stats specific to this `[WebTransportSendStream](#webtransportsendstream)`’s performance, and reports the result asynchronously.

When getStats is called, the user agent MUST run the following steps:

1. Let p be a new promise.
2. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. Let gatheredStats be the [list](https://infra.spec.whatwg.org/#list) of stats specific to [this](https://webidl.spec.whatwg.org/#this) `[WebTransportSendStream](#webtransportsendstream)` needed to populate the[dictionary members](https://webidl.spec.whatwg.org/#dfn-dictionary-member) of `[WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats)` accurately.  
   2. [Queue a network task](#webtransport-queue-a-network-task) with transport to run the following steps:  
         1. Let stats be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats)` object.  
         2. For each [member](https://webidl.spec.whatwg.org/#dfn-dictionary-member) member of stats that the user agent wishes to expose, [set](https://infra.spec.whatwg.org/#map-set) member to the the corresponding [entry](https://infra.spec.whatwg.org/#map-entry) in gatheredStats.  
         3. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with stats.
3. Return p.
`getWriter()` 

This method must be implemented in the same manner as `[getWriter](https://streams.spec.whatwg.org/#ws-get-writer)` inherited from `[WritableStream](https://streams.spec.whatwg.org/#writablestream)`, except in place of creating a`[WritableStreamDefaultWriter](https://streams.spec.whatwg.org/#writablestreamdefaultwriter)`, it must instead[create](#webtransportwriter-create) a `[WebTransportWriter](#webtransportwriter)` with [this](https://webidl.spec.whatwg.org/#this).

### 7.3\. Internal Slots[](#send-stream-internal-slots)

A `[WebTransportSendStream](#webtransportsendstream)` has the following internal slots.

Internal Slot

Description (_non-normative_) 

`[[InternalStream]]` 

An [outgoing unidirectional](#stream-outgoing-unidirectional) or [bidirectional](#stream-bidirectional) [WebTransport stream](#protocol-webtransport-stream). 

`[[PendingOperation]]` 

A promise representing a pending write or close operation, or null. 

`[[Transport]]` 

The `[WebTransport](#webtransport)` that owns this `[WebTransportSendStream](#webtransportsendstream)`. 

`[[SendGroup]]` 

An optional `[WebTransportSendGroup](#webtransportsendgroup)`, or null. 

`[[SendOrder]]` 

An optional send order number, defaulting to 0. 

`[[AtomicWriteRequests]]` 

An [ordered set](https://infra.spec.whatwg.org/#ordered-set) of promises, keeping track of the subset of write requests that are atomic among those queued to be processed by the underlying sink. 

`[[BytesWritten]]` 

The number of bytes that have been written to the stream. 

`[[CommittedOffset]]` 

An offset in the stream that records the number of bytes that will be delivered to a peer, even when the stream has [aborted sending](#stream-abort-sending); see [\[RELIABLE-RESET\]](#biblio-reliable-reset "QUIC Stream Resets with Partial Delivery"). 

### 7.4\. Procedures[](#send-stream-procedures)

To create a`[WebTransportSendStream](#webtransportsendstream)`, with an [outgoing unidirectional](#stream-outgoing-unidirectional) or [bidirectional](#stream-bidirectional) [WebTransport stream](#protocol-webtransport-stream) internalStream, a `[WebTransport](#webtransport)` transport, sendGroup, and asendOrder, run these steps:

Let stream be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportSendStream](#webtransportsendstream)`, with:

`[[[InternalStream]]](#dom-webtransportsendstream-internalstream-slot)` 

internalStream

`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` 

null

`[[[Transport]]](#dom-webtransportsendstream-transport-slot)` 

transport

`[[[SendGroup]]](#dom-webtransportsendstream-sendgroup-slot)` 

sendGroup

`[[[SendOrder]]](#dom-webtransportsendstream-sendorder-slot)` 

sendOrder

`[[[AtomicWriteRequests]]](#dom-webtransportsendstream-atomicwriterequests-slot)` 

An empty [ordered set](https://infra.spec.whatwg.org/#ordered-set) of promises.

`[[[BytesWritten]]](#dom-webtransportsendstream-byteswritten-slot)` 

0

`[[[CommittedOffset]]](#dom-webtransportsendstream-committedoffset-slot)` 

0

* Let writeAlgorithm be an action that [writes](#webtransportsendstream-write) chunk to stream, given chunk.
* Let closeAlgorithm be an action that [closes](#webtransportsendstream-close) stream.
* Let abortAlgorithm be an action that [aborts](#webtransportsendstream-abort) stream with reason, given reason.
* [Set up](https://streams.spec.whatwg.org/#writablestream-set-up) stream with [writeAlgorithm](https://streams.spec.whatwg.org/#writablestream-set-up-writealgorithm) set towriteAlgorithm, [closeAlgorithm](https://streams.spec.whatwg.org/#writablestream-set-up-closealgorithm) set to closeAlgorithm,[abortAlgorithm](https://streams.spec.whatwg.org/#writablestream-set-up-abortalgorithm) set to abortAlgorithm.
* Let abortSignal be stream’s \[\[controller\]\].\[\[abortController\]\].\[\[signal\]\].
* [Add](https://dom.spec.whatwg.org/#abortsignal-add) the following steps to abortSignal.  
1. Let pendingOperation be stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)`.  
2. If pendingOperation is null, then abort these steps.  
3. Set stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` to null.  
4. Let reason be abortSignal’s [abort reason](https://dom.spec.whatwg.org/#abortsignal-abort-reason).  
5. Let promise be the result of [aborting](#webtransportsendstream-abort) stream with reason.  
6. [Upon fulfillment](https://webidl.spec.whatwg.org/#upon-fulfillment) of promise, [reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) pendingOperation with reason.
* [Append](https://infra.spec.whatwg.org/#set-append) stream to transport.`[[[SendStreams]]](#dom-webtransport-sendstreams-slot)`.
* Return stream.

To write chunk to a `[WebTransportSendStream](#webtransportsendstream)` stream, run these steps:
1. Let transport be stream.`[[[Transport]]](#dom-webtransportsendstream-transport-slot)`.
2. If chunk is not a `[BufferSource](https://webidl.spec.whatwg.org/#BufferSource)`, return [a promise rejected with](https://webidl.spec.whatwg.org/#a-promise-rejected-with) a `[TypeError](https://webidl.spec.whatwg.org/#exceptiondef-typeerror)`.
3. Let promise be a new promise.
4. Let bytes be a copy of the [byte sequence](https://infra.spec.whatwg.org/#byte-sequence) which chunk represents.
5. Set stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` to promise.
6. Let inFlightWriteRequest bestream.[inFlightWriteRequest](https://streams.spec.whatwg.org/#writablestream-inflightwriterequest).
7. Let atomic be true if [stream](https://fetch.spec.whatwg.org/#concept-body-stream).`[[[AtomicWriteRequests]]](#dom-webtransportsendstream-atomicwriterequests-slot)` [contains](https://infra.spec.whatwg.org/#list-contain) inFlightWriteRequest, otherwise false.
8. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. If atomic is true and the current [flow control](#stream-signal-flow-control) window is too small for bytes to be sent in its entirety, then abort the remaining steps and [queue a network task](#webtransport-queue-a-network-task) with transport to run these sub-steps:  
         1. Set stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` to null.  
         2. [Abort all atomic write requests](#webtransportsendstream-abort-all-atomic-write-requests) on stream.  
   2. Otherwise, [send](#stream-send) bytes on stream.`[[[InternalStream]]](#dom-webtransportsendstream-internalstream-slot)` and wait for the operation to complete. This sending MAY be interleaved with sending of previously queued streams and datagrams, as well as streams and datagrams yet to be queued to be sent over this transport.  
   The user-agent MAY have a buffer to improve the transfer performance. Such a buffer SHOULD have a fixed upper limit, to carry the backpressure information to the user of the`[WebTransportSendStream](#webtransportsendstream)`.  
   This sending MUST starve until all bytes queued for sending on streams with the same `[[[SendGroup]]](#dom-webtransportsendstream-sendgroup-slot)` and a higher`[[[SendOrder]]](#dom-webtransportsendstream-sendorder-slot)`, that are neither[ errored](https://streams.spec.whatwg.org/#writablestream-error) nor blocked by [flow control](#stream-signal-flow-control), have been sent.  
   We access stream.`[[[SendOrder]]](#dom-webtransportsendstream-sendorder-slot)` [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel) here. User agents SHOULD respond to live updates of these values during sending, though the details are [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined).  
   Note: Ordering of retransmissions is [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined), but user agents are strongly encouraged to prioritize retransmissions of data with higher `[[[SendOrder]]](#dom-webtransportsendstream-sendorder-slot)` values.  
   This sending MUST NOT starve otherwise, except for [flow control](#stream-signal-flow-control) reasons or [ error](https://streams.spec.whatwg.org/#writablestream-error).  
   The user agent SHOULD divide bandwidth fairly between all streams that aren’t starved.  
   Note: The definition of fairness here is [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined).  
   3. If the previous step failed due to a network error, abort the remaining steps.  
   Note: We don’t reject promise here because we handle network errors elsewhere, and those steps reject stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)`.  
   4. Otherwise, [queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
         1. Set stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` to null.  
         2. Add the length of bytes to stream.`[[[BytesWritten]]](#dom-webtransportsendstream-byteswritten-slot)`.  
         3. If stream.`[[[AtomicWriteRequests]]](#dom-webtransportsendstream-atomicwriterequests-slot)` [contains](https://infra.spec.whatwg.org/#list-contain) inFlightWriteRequest, [remove](https://infra.spec.whatwg.org/#list-remove) inFlightWriteRequest.  
         4. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with undefined.
9. Return promise.

Note: The [fulfillment](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) of the promise returned from this algorithm (or,`[write(chunk)](https://streams.spec.whatwg.org/#default-writer-write)`) does **NOT** necessarily mean that the chunk is acked by the server [\[QUIC\]](#biblio-quic "QUIC: A UDP-Based Multiplexed and Secure Transport"). It may just mean that the chunk is appended to the buffer. To make sure that the chunk arrives at the server, the server needs to send an application-level acknowledgment message.

To close a `[WebTransportSendStream](#webtransportsendstream)` stream, run these steps:
1. Let transport be stream.`[[[Transport]]](#dom-webtransportsendstream-transport-slot)`.
2. Let promise be a new promise.
3. [Remove](https://infra.spec.whatwg.org/#list-remove) stream from transport.`[[[SendStreams]]](#dom-webtransport-sendstreams-slot)`.
4. Set stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` to promise.
5. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. [Send](#stream-send) FIN on stream.`[[[InternalStream]]](#dom-webtransportsendstream-internalstream-slot)` and wait for the operation to complete.  
   2. Wait for stream.`[[[InternalStream]]](#dom-webtransportsendstream-internalstream-slot)` to enter the "all data committed" state. [\[QUIC\]](#biblio-quic "QUIC: A UDP-Based Multiplexed and Secure Transport")  
   3. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
         1. Set stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` to null.  
         2. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with undefined.
6. Return promise.

To abort a `[WebTransportSendStream](#webtransportsendstream)` stream with reason, run these steps:
1. Let transport be stream.`[[[Transport]]](#dom-webtransportsendstream-transport-slot)`.
2. Let promise be a new promise.
3. Let code be 0.
4. [Remove](https://infra.spec.whatwg.org/#list-remove) stream from transport.`[[[SendStreams]]](#dom-webtransport-sendstreams-slot)`.
5. If reason is a `[WebTransportError](#webtransporterror)` and reason.`[[[StreamErrorCode]]](#dom-webtransporterror-streamerrorcode-slot)` is not null, then set code to reason.`[[[StreamErrorCode]]](#dom-webtransporterror-streamerrorcode-slot)`.
6. If code < 0, then set code to 0.
7. If code \> 4294967295, then set code to 4294967295.
8. Let committedOffset be stream.`[[[CommittedOffset]]](#dom-webtransportsendstream-committedoffset-slot)`.  
Note: Valid values of code are from 0 to 4294967295 inclusive. If the [underlying connection](#underlying-connection) is using HTTP/3, the code will be encoded to a number in \[0x52e4a40fa8db, 0x52e5ac983162\] as decribed in[\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3").
9. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. [Abort sending](#stream-abort-sending) on stream.`[[[InternalStream]]](#dom-webtransportsendstream-internalstream-slot)` with code and committedOffset.  
   2. [Queue a network task](#webtransport-queue-a-network-task) with transport to [resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with undefined.
10. Return promise.

To abort all atomic write requests on a `[WebTransportSendStream](#webtransportsendstream)` stream, run these steps:
1. Let writeRequests bestream.[writeRequests](https://streams.spec.whatwg.org/#writablestream-writerequests).
2. Let requestsToAbort be [stream](https://fetch.spec.whatwg.org/#concept-body-stream).`[[[AtomicWriteRequests]]](#dom-webtransportsendstream-atomicwriterequests-slot)`.
3. If writeRequests [contains](https://infra.spec.whatwg.org/#list-contain) a promise not in requestsToAbort, then[error](https://streams.spec.whatwg.org/#writablestream-error) stream with `[AbortError](https://webidl.spec.whatwg.org/#aborterror)`, and abort these steps.
4. [Empty](https://infra.spec.whatwg.org/#list-empty) [stream](https://fetch.spec.whatwg.org/#concept-body-stream).`[[[AtomicWriteRequests]]](#dom-webtransportsendstream-atomicwriterequests-slot)`.
5. [For each](https://infra.spec.whatwg.org/#list-iterate) promise in requestsToAbort, [reject](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with `[AbortError](https://webidl.spec.whatwg.org/#aborterror)`.
6. [In parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel), [for each](https://infra.spec.whatwg.org/#list-iterate) promise in requestsToAbort, abort the[sending](#stream-send) of bytes associated with promise.

### 7.5\. Receiving aborted signal coming from the server[](#send-stream-receiving-aborted)

Whenever a [WebTransport stream](#protocol-webtransport-stream) associated with a `[WebTransportSendStream](#webtransportsendstream)` stream gets a[receiving aborted](#stream-signal-receiving-aborted) signal from the server, run these steps:
1. Let transport be stream.`[[[Transport]]](#dom-webtransportsendstream-transport-slot)`.
2. Let code be the application protocol error code attached to the [receiving aborted](#stream-signal-receiving-aborted) signal.  
Note: Valid values of code are from 0 to 4294967295 inclusive. If the [underlying connection](#underlying-connection) is using HTTP/3, the code will be encoded to a number in \[0x52e4a40fa8db, 0x52e5ac983162\] as decribed in[\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3").
3. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
   1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`, abort these steps.  
   2. [Remove](https://infra.spec.whatwg.org/#list-remove) stream from transport.`[[[SendStreams]]](#dom-webtransport-sendstreams-slot)`.  
   3. Let error be a newly [created](https://heycam.github.io/webidl/#dfn-create-exception) `[WebTransportError](#webtransporterror)` whose`[source](#dom-webtransporterroroptions-source)` is `"stream"` and`[streamErrorCode](#dom-webtransporterroroptions-streamerrorcode)` is code.  
   4. If stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` is not null, reject stream.`[[[PendingOperation]]](#dom-webtransportsendstream-pendingoperation-slot)` with error.  
   5. [Error](https://streams.spec.whatwg.org/#writablestream-error) stream with error.

### 7.6\. `WebTransportSendStreamStats` Dictionary[](#send-stream-stats)

The `WebTransportSendStreamStats` dictionary includes information on stats specific to one `[WebTransportSendStream](#webtransportsendstream)`.

dictionary [WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats) {
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesWritten](#dom-webtransportsendstreamstats-byteswritten);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesSent](#dom-webtransportsendstreamstats-bytessent);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesAcknowledged](#dom-webtransportsendstreamstats-bytesacknowledged);
};

The dictionary SHALL have the following attributes:

`bytesWritten`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The total number of bytes the application has successfully written to this`[WebTransportSendStream](#webtransportsendstream)`. This number can only increase.

`bytesSent`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

An indicator of progress on how many of the application bytes written to this`[WebTransportSendStream](#webtransportsendstream)` has been sent at least once. This number can only increase, and is always less than or equal to`[bytesWritten](#dom-webtransportsendstreamstats-byteswritten)`.

Note: this is progress of app data sent on a single stream only, and does not include any network overhead.

`bytesAcknowledged`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

An indicator of progress on how many of the application bytes written to this`[WebTransportSendStream](#webtransportsendstream)` have been sent and acknowledged as received by the server using QUIC’s ACK mechanism. Only sequential bytes up to, but not including, the first non-acknowledged byte, are counted. This number can only increase and is always less than or equal to `[bytesSent](#dom-webtransportsendstreamstats-bytessent)`.

Note: This value will match `[bytesSent](#dom-webtransportsendstreamstats-bytessent)` when the connection is over HTTP/2.

## 8\. Interface `WebTransportSendGroup`[](#sendGroup)

A `[WebTransportSendGroup](#webtransportsendgroup)` is an optional organizational object that tracks transmission of data spread across many individual (typically [strictly ordered](#strict-ordering))`[WebTransportSendStream](#webtransportsendstream)`s.

`[WebTransportSendStream](#webtransportsendstream)`s can, at their creation or through assignment of their `sendGroup` attribute, be grouped under at most one`[WebTransportSendGroup](#webtransportsendgroup)` at any time. By default, they are[ungrouped](#grouped).

The user agent considers `[WebTransportSendGroup](#webtransportsendgroup)`s as equals when allocating bandwidth for sending `[WebTransportSendStream](#webtransportsendstream)`s. Each `[WebTransportSendGroup](#webtransportsendgroup)`also establishes a separate numberspace for evaluating`[sendOrder](#dom-webtransportsendoptions-sendorder)` numbers.

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface `WebTransportSendGroup` {
  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats)> [getStats](#dom-webtransportsendgroup-getstats)();
};

A `[WebTransportSendGroup](#webtransportsendgroup)` is always created by the[create](#webtransportsendgroup-create) procedure.

### 8.1\. Methods[](#sendGroup-methods)

`getStats()` 

Aggregates stats from all `[WebTransportSendStream](#webtransportsendstream)`s[grouped](#grouped) under [this](https://webidl.spec.whatwg.org/#this) sendGroup, and reports the result asynchronously.

When getStats is called, the user agent MUST run the following steps:

1. Let p be a new promise.
2. Let streams be all `[WebTransportSendStream](#webtransportsendstream)`s whose`[[[SendGroup]]](#dom-webtransportsendstream-sendgroup-slot)` is [this](https://webidl.spec.whatwg.org/#this).
3. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. Let gatheredStats be the [list](https://infra.spec.whatwg.org/#list) of aggregated stats from all streams in streams needed to populate the[dictionary members](https://webidl.spec.whatwg.org/#dfn-dictionary-member) of `[WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats)` accurately.  
   2. [Queue a network task](#webtransport-queue-a-network-task) with transport to run the following steps:  
         1. Let stats be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats)` object.  
         2. For each [member](https://webidl.spec.whatwg.org/#dfn-dictionary-member) member of stats that the user agent wishes to expose, [set](https://infra.spec.whatwg.org/#map-set) member to the the corresponding [entry](https://infra.spec.whatwg.org/#map-entry) in gatheredStats.  
         3. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with stats.
4. Return p.

### 8.2\. Internal Slots[](#sendGroup-internal-slots)

A `[WebTransportSendGroup](#webtransportsendgroup)` has the following internal slots.

Internal Slot

Description (_non-normative_) 

`[[Transport]]` 

The `[WebTransport](#webtransport)` object owning this `[WebTransportSendGroup](#webtransportsendgroup)`. 

### 8.3\. Procedures[](#sendGroup-procedures)

To create a`[WebTransportSendGroup](#webtransportsendgroup)`, with a `[WebTransport](#webtransport)` transport, run these steps:

Let sendGroup be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportSendGroup](#webtransportsendgroup)`, with:

`[[[Transport]]](#dom-webtransportsendgroup-transport-slot)` 

transport

* Return sendGroup.

## 9\. Interface `WebTransportReceiveStream`[](#receive-stream)

A `[WebTransportReceiveStream](#webtransportreceivestream)` is a `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)` providing incoming streaming features with an [incoming unidirectional](#stream-incoming-unidirectional) or [bidirectional](#stream-bidirectional) [WebTransport stream](#protocol-webtransport-stream).

It is a `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)` of `[Uint8Array](https://webidl.spec.whatwg.org/#idl-Uint8Array)` that can be read from, to consume data received from the server. `[WebTransportReceiveStream](#webtransportreceivestream)` is a [readable byte stream](https://streams.spec.whatwg.org/#readable-byte-stream), and hence it allows its consumers to use a [BYOB reader](https://streams.spec.whatwg.org/#byob-reader) as well as a [default reader](https://streams.spec.whatwg.org/#default-reader).

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext), [Transferable](https://html.spec.whatwg.org/multipage/structured-data.html#transferable)]
interface `WebTransportReceiveStream` : [ReadableStream](https://streams.spec.whatwg.org/#readablestream) {
  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportReceiveStreamStats](#dictdef-webtransportreceivestreamstats)> [getStats](#dom-webtransportreceivestream-getstats)();
};

A `[WebTransportReceiveStream](#webtransportreceivestream)` is always created by the[create](#webtransportreceivestream-create) procedure.

The `[WebTransportReceiveStream](#webtransportreceivestream)`’s [transfer steps](https://html.spec.whatwg.org/multipage/structured-data.html#transfer-steps) and[transfer-receiving steps](https://html.spec.whatwg.org/multipage/structured-data.html#transfer-receiving-steps) are[those of](https://streams.spec.whatwg.org/#rs-transfer) `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)`.

### 9.1\. Methods[](#receive-stream-methods)

`getStats()` 

Gathers stats specific to this `[WebTransportReceiveStream](#webtransportreceivestream)`’s performance, and reports the result asynchronously.

When getStats is called, the user agent MUST run the following steps:

1. Let p be a new promise.
2. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. Let gatheredStats be the [list](https://infra.spec.whatwg.org/#list) of stats specific to [this](https://webidl.spec.whatwg.org/#this) `[WebTransportReceiveStream](#webtransportreceivestream)` needed to populate the[dictionary members](https://webidl.spec.whatwg.org/#dfn-dictionary-member) of `[WebTransportReceiveStreamStats](#dictdef-webtransportreceivestreamstats)` accurately.  
   2. [Queue a network task](#webtransport-queue-a-network-task) with transport to run the following steps:  
         1. Let stats be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportReceiveStreamStats](#dictdef-webtransportreceivestreamstats)` object.  
         2. For each [member](https://webidl.spec.whatwg.org/#dfn-dictionary-member) member of stats that the user agent wishes to expose, [set](https://infra.spec.whatwg.org/#map-set) member to the the corresponding [entry](https://infra.spec.whatwg.org/#map-entry) in gatheredStats.  
         3. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) p with stats.
3. Return p.

### 9.2\. Internal Slots[](#receive-stream-internal-slots)

A `[WebTransportReceiveStream](#webtransportreceivestream)` has the following internal slots.

Internal Slot

Description (_non-normative_) 

`[[InternalStream]]` 

An [incoming unidirectional](#stream-incoming-unidirectional) or [bidirectional](#stream-bidirectional) [WebTransport stream](#protocol-webtransport-stream). 

`[[Transport]]` 

The `[WebTransport](#webtransport)` object owning this `[WebTransportReceiveStream](#webtransportreceivestream)`.

### 9.3\. Procedures[](#receive-stream-procedures)

To create a`[WebTransportReceiveStream](#webtransportreceivestream)`, with an [incoming unidirectional](#stream-incoming-unidirectional) or [bidirectional](#stream-bidirectional) [WebTransport stream](#protocol-webtransport-stream) internalStream and a `[WebTransport](#webtransport)` transport, run these steps:

Let stream be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportReceiveStream](#webtransportreceivestream)`, with:

`[[[InternalStream]]](#dom-webtransportreceivestream-internalstream-slot)` 

internalStream

`[[[Transport]]](#dom-webtransportreceivestream-transport-slot)` 

transport

* Let pullAlgorithm be an action that [pulls bytes](#webtransportreceivestream-pull-bytes) from stream.
* Let cancelAlgorithm be an action that [cancels](#webtransportreceivestream-cancel) stream with reason, givenreason.
* [Set up with byte reading support](https://streams.spec.whatwg.org/#readablestream-set-up-with-byte-reading-support) stream with[pullAlgorithm](https://streams.spec.whatwg.org/#readablestream-set-up-with-byte-reading-support-pullalgorithm) set to pullAlgorithm and[cancelAlgorithm](https://streams.spec.whatwg.org/#readablestream-set-up-with-byte-reading-support-cancelalgorithm) set to cancelAlgorithm.
* [Append](https://infra.spec.whatwg.org/#set-append) stream to transport.`[[[ReceiveStreams]]](#dom-webtransport-receivestreams-slot)`.
* Return stream.

To pull bytes from a `[WebTransportReceiveStream](#webtransportreceivestream)` stream, run these steps.

1. Let transport be stream.`[[[Transport]]](#dom-webtransportreceivestream-transport-slot)`.
2. Let internalStream be stream.`[[[InternalStream]]](#dom-webtransportreceivestream-internalstream-slot)`.
3. Let promise be a new promise.
4. Let buffer, offset, and maxBytes be null.
5. If stream’s [current BYOB request view](https://streams.spec.whatwg.org/#readablestream-current-byob-request-view) for stream is not null:  
   1. Set offset to stream’s [current BYOB request view](https://streams.spec.whatwg.org/#readablestream-current-byob-request-view).\[\[ByteOffset\]\].  
   2. Set maxBytes to stream’s [current BYOB request view](https://streams.spec.whatwg.org/#readablestream-current-byob-request-view)’s[byte length](https://webidl.spec.whatwg.org/#buffersource-byte-length).  
   3. Set buffer to stream’s [current BYOB request view](https://streams.spec.whatwg.org/#readablestream-current-byob-request-view)’s[underlying buffer](https://webidl.spec.whatwg.org/#buffersource-underlying-buffer).
6. Otherwise:  
   1. Set offset to 0.  
   2. Set maxBytes to an [implementation-defined](https://infra.spec.whatwg.org/#implementation-defined) size.  
   3. Set buffer be a [new](https://webidl.spec.whatwg.org/#new) `[ArrayBuffer](https://webidl.spec.whatwg.org/#idl-ArrayBuffer)` with maxBytes size. If allocating the`[ArrayBuffer](https://webidl.spec.whatwg.org/#idl-ArrayBuffer)` fails, return [a promise rejected with](https://webidl.spec.whatwg.org/#a-promise-rejected-with) a `[RangeError](https://webidl.spec.whatwg.org/#exceptiondef-rangeerror)`.
7. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. [Write](https://webidl.spec.whatwg.org/#arraybuffer-write) the bytes that area [read](#stream-receive) from internalStream intobuffer with offset offset, up to maxBytes bytes. Wait until either at least one byte is read or FIN is received. Let read be the number of read bytes, and let hasReceivedFIN be whether FIN was accompanied.  
   The user-agent MAY have a buffer to improve the transfer performance. Such a buffer SHOULD have a fixed upper limit, to carry the backpressure information to the server.  
   Note: This operation may return before filling up all of buffer.  
   2. If the previous step failed, abort the remaining steps.  
   Note: We don’t reject promise here because we handle network errors elsewhere, and those steps[error](https://streams.spec.whatwg.org/#readablestream-error) stream, which rejects any read requests awaiting this pull.  
   3. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
   Note: If the buffer described above is available in the [event loop](https://html.spec.whatwg.org/multipage/webappapis.html#concept-agent-event-loop) where this procedure is running, the following steps may run immediately.  
         1. If read \> 0:  
                  1. Set view to a new `[Uint8Array](https://webidl.spec.whatwg.org/#idl-Uint8Array)` with buffer, offset and read.  
                  2. [Enqueue](https://streams.spec.whatwg.org/#readablestream-enqueue) view into stream.  
         2. If hasReceivedFIN is true:  
                  1. [Remove](https://infra.spec.whatwg.org/#list-remove) stream from transport.`[[[ReceiveStreams]]](#dom-webtransport-receivestreams-slot)`.  
                  2. [Close](https://streams.spec.whatwg.org/#readablestream-close) stream.  
         3. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with undefined.
8. Return promise.

To cancel a `[WebTransportReceiveStream](#webtransportreceivestream)` stream with reason, run these steps.

1. Let transport be stream.`[[[Transport]]](#dom-webtransportreceivestream-transport-slot)`.
2. Let internalStream be stream.`[[[InternalStream]]](#dom-webtransportreceivestream-internalstream-slot)`.
3. Let promise be a new promise.
4. Let code be 0.
5. If reason is a `[WebTransportError](#webtransporterror)` and reason.`[[[StreamErrorCode]]](#dom-webtransporterror-streamerrorcode-slot)` is not null, then set code to reason.`[[[StreamErrorCode]]](#dom-webtransporterror-streamerrorcode-slot)`.
6. If code < 0, then set code to 0.
7. If code \> 4294967295, then set code to 4294967295.  
Note: Valid values of code are from 0 to 4294967295 inclusive. If the [underlying connection](#underlying-connection) is using HTTP/3, the code will be encoded to a number in \[0x52e4a40fa8db, 0x52e5ac983162\] as decribed in[\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3").
8. [Remove](https://infra.spec.whatwg.org/#list-remove) stream from transport.`[[[SendStreams]]](#dom-webtransport-sendstreams-slot)`.
9. Run the following steps [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel):  
   1. [Abort receiving](#stream-abort-receiving) on internalStream with code.  
   2. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
   Note: If the buffer described above is available in the [event loop](https://html.spec.whatwg.org/multipage/webappapis.html#concept-agent-event-loop) where this procedure is running, the following steps may run immediately.  
         1. [Remove](https://infra.spec.whatwg.org/#list-remove) stream from transport.`[[[ReceiveStreams]]](#dom-webtransport-receivestreams-slot)`.  
         2. [Resolve](http://www.ecma-international.org/ecma-262/6.0/index.html#sec-promise-objects) promise with undefined.
10. Return promise.

### 9.4\. Sending aborted signal coming from the server[](#receive-stream-sending-aborted)

Whenever a [WebTransport stream](#protocol-webtransport-stream) associated with a `[WebTransportReceiveStream](#webtransportreceivestream)` stream gets a[sending aborted](#stream-signal-sending-aborted) signal from the server, run these steps:
1. Let transport be stream.`[[[Transport]]](#dom-webtransportreceivestream-transport-slot)`.
2. Let code be the application protocol error code attached to the [sending aborted](#stream-signal-sending-aborted) signal.  
Note: Valid values of code are from 0 to 4294967295 inclusive. If the [underlying connection](#underlying-connection) is using HTTP/3, the code will be encoded to a number in \[0x52e4a40fa8db, 0x52e5ac983162\] as decribed in[\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3").
3. [Queue a network task](#webtransport-queue-a-network-task) with transport to run these steps:  
   1. If transport.`[[[State]]](#dom-webtransport-state-slot)` is `"closed"` or `"failed"`, abort these steps.  
   2. [Remove](https://infra.spec.whatwg.org/#list-remove) stream from transport.`[[[ReceiveStreams]]](#dom-webtransport-receivestreams-slot)`.  
   3. Let error be a newly [created](https://heycam.github.io/webidl/#dfn-create-exception) `[WebTransportError](#webtransporterror)` whose`[source](#dom-webtransporterroroptions-source)` is `"stream"` and`[streamErrorCode](#dom-webtransporterroroptions-streamerrorcode)` is code.  
   4. [Error](https://streams.spec.whatwg.org/#readablestream-error) stream with error.

### 9.5\. `WebTransportReceiveStreamStats` Dictionary[](#receive-stream-stats)

The `WebTransportReceiveStreamStats` dictionary includes information on stats specific to one `[WebTransportReceiveStream](#webtransportreceivestream)`.

dictionary [WebTransportReceiveStreamStats](#dictdef-webtransportreceivestreamstats) {
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesReceived](#dom-webtransportreceivestreamstats-bytesreceived);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesRead](#dom-webtransportreceivestreamstats-bytesread);
};

The dictionary SHALL have the following attributes:

`bytesReceived`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

An indicator of progress on how many of the server application’s bytes intended for this `[WebTransportReceiveStream](#webtransportreceivestream)` have been received so far. Only sequential bytes up to, but not including, the first missing byte, are counted. This number can only increase.

Note: this is progress of app data received on a single stream only, and does not include any network overhead.

`bytesRead`,  of type [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) 

The total number of bytes the application has successfully read from this`[WebTransportReceiveStream](#webtransportreceivestream)`. This number can only increase, and is always less than or equal to `[bytesReceived](#dom-webtransportreceivestreamstats-bytesreceived)`.

## 10\. Interface `WebTransportBidirectionalStream`[](#bidirectional-stream)

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface `WebTransportBidirectionalStream` {
  readonly attribute [WebTransportReceiveStream](#webtransportreceivestream) [readable](#dom-webtransportbidirectionalstream-readable);
  readonly attribute [WebTransportSendStream](#webtransportsendstream) [writable](#dom-webtransportbidirectionalstream-writable);
};

### 10.1\. Internal slots[](#bidirectional-stream-internal-slots)

A `[WebTransportBidirectionalStream](#webtransportbidirectionalstream)` has the following internal slots.

Internal Slot

Description (_non-normative_) 

`[[Readable]]` 

A `[WebTransportReceiveStream](#webtransportreceivestream)`. 

`[[Writable]]` 

A `[WebTransportSendStream](#webtransportsendstream)`. 

`[[Transport]]` 

The `[WebTransport](#webtransport)` object owning this`[WebTransportBidirectionalStream](#webtransportbidirectionalstream)`.

### 10.2\. Attributes[](#bidirectional-stream-attributes)

`readable`,  of type [WebTransportReceiveStream](#webtransportreceivestream), readonly 

The getter steps are to return [this](https://webidl.spec.whatwg.org/#this)’s `[[[Readable]]](#dom-webtransportbidirectionalstream-readable-slot)`.

`writable`,  of type [WebTransportSendStream](#webtransportsendstream), readonly 

The getter steps are to return [this](https://webidl.spec.whatwg.org/#this)’s `[[[Writable]]](#dom-webtransportbidirectionalstream-writable-slot)`.

### 10.3\. Procedures[](#bidirectional-stream-procedures)

To create a `[WebTransportBidirectionalStream](#webtransportbidirectionalstream)` with a[bidirectional](#stream-bidirectional) [WebTransport stream](#protocol-webtransport-stream) internalStream, a `[WebTransport](#webtransport)`object transport, and a sendOrder, run these steps. 
* Let readable be the result of [creating](#webtransportreceivestream-create) a `[WebTransportReceiveStream](#webtransportreceivestream)` withinternalStream and transport.
* Let writable be the result of [creating](#webtransportsendstream-create) a `[WebTransportSendStream](#webtransportsendstream)` withinternalStream, transport, and sendOrder.

Let stream be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportBidirectionalStream](#webtransportbidirectionalstream)`, with:

`[[[Readable]]](#dom-webtransportbidirectionalstream-readable-slot)` 

readable

`[[[Writable]]](#dom-webtransportbidirectionalstream-writable-slot)` 

writable

`[[[Transport]]](#dom-webtransportbidirectionalstream-transport-slot)` 

transport

* Return stream.

## 11\. `WebTransportWriter` Interface[](#web-transport-writer-interface)

`[WebTransportWriter](#webtransportwriter)` is a subclass of `[WritableStreamDefaultWriter](https://streams.spec.whatwg.org/#writablestreamdefaultwriter)` that adds two methods.

A `[WebTransportWriter](#webtransportwriter)` is always created by the[create](#webtransportwriter-create) procedure.

[Exposed=*, [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface `WebTransportWriter` : [WritableStreamDefaultWriter](https://streams.spec.whatwg.org/#writablestreamdefaultwriter) {
  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[undefined](https://webidl.spec.whatwg.org/#idl-undefined)> [atomicWrite](#dom-webtransportwriter-atomicwrite)(optional [any](https://webidl.spec.whatwg.org/#idl-any) `chunk`);
  [undefined](https://webidl.spec.whatwg.org/#idl-undefined) [commit](#dom-webtransportwriter-commit)();
};

### 11.1\. Methods[](#web-transport-writer-methods)

`atomicWrite(chunk)` 

The `[atomicWrite](#dom-webtransportwriter-atomicwrite)` method will reject if the chunk given to it could not be sent in its entirety within the [flow control](#stream-signal-flow-control) window that is current at the time of sending. This behavior is designed to satisfy niche transactional applications sensitive to [flow control](#stream-signal-flow-control) deadlocks ([\[RFC9308\]](#biblio-rfc9308 "Applicability of the QUIC Transport Protocol") [Section 4.4](https://datatracker.ietf.org/doc/html/rfc9308#section-4.4)).

Note: `[atomicWrite](#dom-webtransportwriter-atomicwrite)` can still reject after sending some data. Though it provides atomicity with respect to flow control, other errors may occur.`[atomicWrite](#dom-webtransportwriter-atomicwrite)` does not prevent data from being split between packets or being interleaved with other data. Only the sender learns if`[atomicWrite](#dom-webtransportwriter-atomicwrite)` fails due to lack of available flow control credit.

Note: Atomic writes can still block if queued behind non-atomic writes. If the atomic write is rejected, everything queued behind it at that moment will be rejected as well. Any non-atomic writes rejected in this way will[error](https://streams.spec.whatwg.org/#writablestream-error) the stream. Applications are therefore encouraged to always await atomic writes.

When `[atomicWrite](#dom-webtransportwriter-atomicwrite)` is called, the user agent MUST run the following steps:

1. Let p be the result of `[write(chunk)](https://streams.spec.whatwg.org/#default-writer-write)` on `[WritableStreamDefaultWriter](https://streams.spec.whatwg.org/#writablestreamdefaultwriter)` with chunk.
2. [Append](https://infra.spec.whatwg.org/#set-append) p to stream.`[[[AtomicWriteRequests]]](#dom-webtransportsendstream-atomicwriterequests-slot)`.
3. Return the result of [reacting](https://webidl.spec.whatwg.org/#dfn-perform-steps-once-promise-is-settled) to p with the following steps:  
   1. If stream.`[[[AtomicWriteRequests]]](#dom-webtransportsendstream-atomicwriterequests-slot)` [contains](https://infra.spec.whatwg.org/#list-contain) p,[remove](https://infra.spec.whatwg.org/#list-remove) p.  
   2. If p was rejected with reason r, then return [a promise rejected with](https://webidl.spec.whatwg.org/#a-promise-rejected-with) r.  
   3. Return undefined.
`commit()` 

The `[commit](#dom-webtransportwriter-commit)` method will update the `[[[CommittedOffset]]](#dom-webtransportsendstream-committedoffset-slot)` of a stream to match the number of bytes written to that stream (`[[[BytesWritten]]](#dom-webtransportsendstream-byteswritten-slot)`). This ensures that those bytes will be delivered to a peer reliably, even after writing is [aborted](#webtransportsendstream-abort), causing the stream to [abort sending](#stream-abort-sending). This uses the mechanism described in [\[RELIABLE-RESET\]](#biblio-reliable-reset "QUIC Stream Resets with Partial Delivery").

Note: This does not guarantee delivery in the event that a connection fails, only when a stream has [aborted sending](#stream-abort-sending).

When `[commit](#dom-webtransportwriter-commit)` is called for stream, the user agent MUST run the following steps:

1. Let transport be stream.`[[[Transport]]](#dom-webtransportsendstream-transport-slot)`.
2. Set stream.`[[[CommittedOffset]]](#dom-webtransportsendstream-committedoffset-slot)` to the value of stream.`[[[BytesWritten]]](#dom-webtransportsendstream-byteswritten-slot)`.

### 11.2\. Procedures[](#web-transport-writer-procedures)

To create a`[WebTransportWriter](#webtransportwriter)`, with a `[WebTransportSendStream](#webtransportsendstream)` stream, run these steps:

1. Let writer be a [new](https://webidl.spec.whatwg.org/#new) `[WebTransportWriter](#webtransportwriter)`.
2. Run the [new WritableStreamDefaultWriter(stream)](https://streams.spec.whatwg.org/#default-writer-constructor) constructor steps passing writer as this, and stream as the constructor argument.
3. Return writer.

## 12\. `WebTransportError` Interface[](#web-transport-error-interface)

`WebTransportError` is a subclass of `[DOMException](https://webidl.spec.whatwg.org/#idl-DOMException)` that represents

* An error coming from the server or the network, or
* A reason for a client-initiated abort operation.

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [Serializable](https://html.spec.whatwg.org/multipage/structured-data.html#serializable), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface [WebTransportError](#webtransporterror) : [DOMException](https://webidl.spec.whatwg.org/#idl-DOMException) {
  [constructor](#dom-webtransporterror-webtransporterror)(optional [DOMString](https://webidl.spec.whatwg.org/#idl-DOMString) `message` = "", optional [WebTransportErrorOptions](#dictdef-webtransporterroroptions) `options` = {});

  readonly attribute [WebTransportErrorSource](#enumdef-webtransporterrorsource) [source](#dom-webtransporterror-source);
  readonly attribute [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long)? [streamErrorCode](#dom-webtransporterror-streamerrorcode);
};

dictionary `WebTransportErrorOptions` {
  [WebTransportErrorSource](#enumdef-webtransporterrorsource) `source` = "stream";
  [[Clamp](https://webidl.spec.whatwg.org/#Clamp)] [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long)? `streamErrorCode` = null;
};

enum `WebTransportErrorSource` {
  `"stream"`,
  `"session"`,
};

### 12.1\. Internal slots[](#web-transport-error-internal-slots)

A `[WebTransportError](#webtransporterror)` has the following internal slots.

Internal Slot

Description (_non-normative_) 

`[[Source]]` 

A `[WebTransportErrorSource](#enumdef-webtransporterrorsource)` indicating the source of this error. 

`[[StreamErrorCode]]` 

The application protocol error code for this error, or null.

### 12.2\. Constructor[](#web-transport-error-constructor1)

The `new WebTransportError(message, options)`constructor steps are:

* Set this’s [name](https://heycam.github.io/webidl/#domexception-name) to `"WebTransportError"`.
* Set this’s [message](https://heycam.github.io/webidl/#domexception-message) to message.

Set this’s internal slots as follows:

`[[[Source]]](#dom-webtransporterror-source-slot)` 

options.`[source](#dom-webtransporterroroptions-source)`

`[[[StreamErrorCode]]](#dom-webtransporterror-streamerrorcode-slot)` 

options.`[streamErrorCode](#dom-webtransporterroroptions-streamerrorcode)`

Note: This name does not have a mapping to a legacy code, so [this](https://webidl.spec.whatwg.org/#this)’s `[code](https://webidl.spec.whatwg.org/#dom-domexception-code)` is 0.

### 12.3\. Attributes[](#web-transport-error-attributes)

`source`,  of type [WebTransportErrorSource](#enumdef-webtransporterrorsource), readonly 

The getter steps are to return [this](https://webidl.spec.whatwg.org/#this)’s `[[[Source]]](#dom-webtransporterror-source-slot)`.

`streamErrorCode`,  of type [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long), readonly, nullable 

The getter steps are to return [this](https://webidl.spec.whatwg.org/#this)’s `[[[StreamErrorCode]]](#dom-webtransporterror-streamerrorcode-slot)`.

### 12.4\. Serialization[](#web-transport-error-serialization)

`[WebTransportError](#webtransporterror)` objects are [serializable objects](https://html.spec.whatwg.org/multipage/structured-data.html#serializable-objects). Their [serialization steps](https://html.spec.whatwg.org/multipage/structured-data.html#serialization-steps), given value and serialized, are:

1. Run the `[DOMException](https://webidl.spec.whatwg.org/#idl-DOMException)` [serialization steps](https://html.spec.whatwg.org/multipage/structured-data.html#serialization-steps) given value and serialized.
2. Set serialized.`[[Source]]` to value.`[[[Source]]](#dom-webtransporterror-source-slot)`.
3. Set serialized.`[[StreamErrorCode]]` to value.`[[[StreamErrorCode]]](#dom-webtransporterror-streamerrorcode-slot)`.

Their [deserialization steps](https://html.spec.whatwg.org/multipage/structured-data.html#deserialization-steps), given serialized and value, are:

1. Run the `[DOMException](https://webidl.spec.whatwg.org/#idl-DOMException)` [deserialization steps](https://html.spec.whatwg.org/multipage/structured-data.html#deserialization-steps) given serialized and value.
2. Set value.`[[[Source]]](#dom-webtransporterror-source-slot)` to serialized.`[[Source]]`.
3. Set value.`[[[StreamErrorCode]]](#dom-webtransporterror-streamerrorcode-slot)` serialized.`[[StreamErrorCode]]`.

## 13\. Protocol Mappings[](#protocol-mapping)

_This section is non-normative._

This section describes the underlying protocol behavior of methods defined in this specification, utilizing [\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework"). Cause and effect may not be immediate due to buffering.

WebTransport Protocol Action

API Effect 

Session [drained](#session-draining) 

await wt.`[draining](#dom-webtransport-draining)` 

If the [underlying connection](#underlying-connection) is using HTTP/3, the following protocol behaviors from [\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3") apply.

The application `[streamErrorCode](#dom-webtransporterror-streamerrorcode)` in the `[WebTransportError](#webtransporterror)` error is converted to an httpErrorCode, and vice versa, as specified in [\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3") [Section 4.3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3/#section-4.3).

API Method

QUIC Protocol Action 

`[writable](#dom-webtransportbidirectionalstream-writable)`.`[abort](https://streams.spec.whatwg.org/#ws-abort)`(error)

[aborts sending](#stream-abort-sending) on STREAM with httpErrorCode and an offset that corresponds to the `[[[CommittedOffset]]](#dom-webtransportsendstream-committedoffset-slot)` for the `[stream](#dom-webtransportbidirectionalstream-writable)`, plus any stream header; see [\[RELIABLE-RESET\]](#biblio-reliable-reset "QUIC Stream Resets with Partial Delivery") 

`[writable](#dom-webtransportbidirectionalstream-writable)`.`[close](https://streams.spec.whatwg.org/#ws-close)`()

[sends](#stream-send) STREAM with FIN bit set 

`[writable](#dom-webtransportbidirectionalstream-writable)`.getWriter().`[write(chunk)](https://streams.spec.whatwg.org/#default-writer-write)`()

[sends](#stream-send) STREAM 

`[writable](#dom-webtransportbidirectionalstream-writable)`.getWriter().`[close](https://streams.spec.whatwg.org/#default-writer-close)`()

[sends](#stream-send) STREAM with FIN bit set 

`[writable](#dom-webtransportbidirectionalstream-writable)`.getWriter().`[abort](https://streams.spec.whatwg.org/#default-writer-abort)`(error)

[aborts sending](#stream-abort-sending) on STREAM with httpErrorCode and an offset that corresponds to the `[[[CommittedOffset]]](#dom-webtransportsendstream-committedoffset-slot)` for the `[stream](#dom-webtransportbidirectionalstream-writable)`, plus any stream header; see [\[RELIABLE-RESET\]](#biblio-reliable-reset "QUIC Stream Resets with Partial Delivery") 

`[readable](#dom-webtransportbidirectionalstream-readable)`.`[cancel](https://streams.spec.whatwg.org/#rs-cancel)`(error)

[aborts receiving](#stream-abort-receiving) on STREAM with httpErrorCode 

`[readable](#dom-webtransportbidirectionalstream-readable)`.getReader().`[cancel](https://streams.spec.whatwg.org/#generic-reader-cancel)`(error)

[aborts receiving](#stream-abort-receiving) on STREAM with httpErrorCode 

wt.`[close](#dom-webtransport-close)`(closeInfo)

[terminates](#session-terminate) session with closeInfo  

QUIC Protocol Action

API Effect 

received [STOP\_SENDING](#stream-signal-receiving-aborted) with httpErrorCode

[errors](https://streams.spec.whatwg.org/#writablestream-error) `[writable](#dom-webtransportbidirectionalstream-writable)` with `[streamErrorCode](#dom-webtransporterror-streamerrorcode)` 

[received](#stream-receive) STREAM

(await`[readable](#dom-webtransportbidirectionalstream-readable)`.getReader().`[read](https://streams.spec.whatwg.org/#default-reader-read)`()).value 

[received](#stream-receive) STREAM with FIN bit set

(await`[readable](#dom-webtransportbidirectionalstream-readable)`.getReader().`[read](https://streams.spec.whatwg.org/#default-reader-read)`()).done 

received [RESET\_STREAM](#stream-signal-sending-aborted) with httpErrorCode

[errors](https://streams.spec.whatwg.org/#readablestream-error) `[readable](#dom-webtransportbidirectionalstream-readable)` with `[streamErrorCode](#dom-webtransporterror-streamerrorcode)` 

Session cleanly [terminated](#session-terminated) with closeInfo  

(await wt.`[closed](#dom-webtransport-closed)`).closeInfo, and[errors](https://streams.spec.whatwg.org/#readablestream-error) open streams 

Network error  

(await wt.`[closed](#dom-webtransport-closed)`) rejects, and[errors](https://streams.spec.whatwg.org/#readablestream-error) open streams

Note: As discussed in [Section 3.2](https://www.rfc-editor.org/rfc/rfc9000#section-3.2) of [\[QUIC\]](#biblio-quic "QUIC: A UDP-Based Multiplexed and Secure Transport"), receipt of a RESET\_STREAM frame or RESET\_STREAM\_AT frame ([\[RELIABLE-RESET\]](#biblio-reliable-reset "QUIC Stream Resets with Partial Delivery")) is not always indicated to the application. Receipt of the reset can be signaled immediately, interrupting delivery of stream data with any data not consumed being discarded. However, immediate signaling is not required. In particular, this signal might be delayed to allow delivery of the data indicated by the Reliable Size field in a RESET\_STREAM\_AT frame. If stream data has been completely received but has not yet been read by the application, the sending aborted signal can be suppressed. WebTransport always uses the RESET\_STREAM\_AT frame to ensure reliable delivery of the stream header; see [Section 4.1](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3#section-4.1) and [Section 4.2](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3#section-4.2)of [\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3").

HTTP/3 Protocol Action

API Effect 

Session [drained](#session-draining) 

await wt.`[draining](#dom-webtransport-draining)` 

If the [underlying connection](#underlying-connection) is using HTTP/2, the following protocol behaviors from [\[WEB-TRANSPORT-HTTP2\]](#biblio-web-transport-http2 "WebTransport over HTTP/2") apply. Note that, unlike for HTTP/3, the stream error code does not need to be converted to an HTTP error code, and vice versa.

API Method

HTTP/2 Protocol Action 

`[writable](#dom-webtransportbidirectionalstream-writable)`.`[abort](https://streams.spec.whatwg.org/#ws-abort)`(error)

[aborts sending](#stream-abort-sending) on WT\_STREAM with error 

`[writable](#dom-webtransportbidirectionalstream-writable)`.`[close](https://streams.spec.whatwg.org/#ws-close)`()

[sends](#stream-send) WT\_STREAM with FIN bit set 

`[writable](#dom-webtransportbidirectionalstream-writable)`.getWriter().`[write](https://streams.spec.whatwg.org/#default-writer-write)`()

[sends](#stream-send) WT\_STREAM 

`[writable](#dom-webtransportbidirectionalstream-writable)`.getWriter().`[close](https://streams.spec.whatwg.org/#default-writer-close)`()

[sends](#stream-send) WT\_STREAM with FIN bit set 

`[writable](#dom-webtransportbidirectionalstream-writable)`.getWriter().`[abort](https://streams.spec.whatwg.org/#default-writer-abort)`(error)

[aborts sending](#stream-abort-sending) on WT\_STREAM with error 

`[readable](#dom-webtransportbidirectionalstream-readable)`.`[cancel](https://streams.spec.whatwg.org/#rs-cancel)`(error)

[aborts receiving](#stream-abort-receiving) on WT\_STREAM with error 

`[readable](#dom-webtransportbidirectionalstream-readable)`.getReader().`[cancel](https://streams.spec.whatwg.org/#generic-reader-cancel)`(error)

[aborts receiving](#stream-abort-receiving) on WT\_STREAM with error 

wt.`[close](#dom-webtransport-close)`(closeInfo)

[terminates](#session-terminate) session with closeInfo  

HTTP/2 Protocol Action

API Effect 

received [WT\_STOP\_SENDING](#stream-signal-receiving-aborted) with error

[errors](https://streams.spec.whatwg.org/#writablestream-error) `[writable](#dom-webtransportbidirectionalstream-writable)` with `[streamErrorCode](#dom-webtransporterror-streamerrorcode)` 

[received](#stream-receive) WT\_STREAM

(await`[readable](#dom-webtransportbidirectionalstream-readable)`.getReader().`[read](https://streams.spec.whatwg.org/#default-reader-read)`()).value 

[received](#stream-receive) WT\_STREAM with FIN bit set

(await`[readable](#dom-webtransportbidirectionalstream-readable)`.getReader().`[read](https://streams.spec.whatwg.org/#default-reader-read)`()).done 

received [WT\_RESET\_STREAM](#stream-signal-sending-aborted) with error

[errors](https://streams.spec.whatwg.org/#readablestream-error) `[readable](#dom-webtransportbidirectionalstream-readable)` with `[streamErrorCode](#dom-webtransporterror-streamerrorcode)` 

Session cleanly [terminated](#session-terminated) with closeInfo  

(await wt.`[closed](#dom-webtransport-closed)`).closeInfo, and[errors](https://streams.spec.whatwg.org/#readablestream-error) open streams 

Network error  

(await wt.`[closed](#dom-webtransport-closed)`) rejects, and[errors](https://streams.spec.whatwg.org/#readablestream-error) open streams 

Session [drained](#session-draining) 

await wt.`[draining](#dom-webtransport-draining)` 

## 14\. Privacy and Security Considerations[](#privacy-security)

This section is non-normative; it specifies no new behaviour, but instead summarizes information already present in other parts of the specification.

### 14.1\. Confidentiality of Communications[](#confidentiality)

The fact that communication is taking place cannot be hidden from adversaries that can observe the network, so this has to be regarded as public information.

All of the transport protocols described in this document use either TLS[\[RFC8446\]](#biblio-rfc8446 "The Transport Layer Security (TLS) Protocol Version 1.3") or a semantically equivalent protocol, thus providing all of the security properties of TLS, including confidentiality and integrity of the traffic. WebTransport over HTTP uses the same certificate verification mechanism as outbound HTTP requests, thus relying on the same public key infrastructure for authentication of the remote server. In WebTransport, certificate verification errors are fatal; no interstitial allowing bypassing certificate validation is available.

### 14.2\. State Persistence[](#state-persistence)

WebTransport does not by itself create any new unique identifiers or new ways to persistently store state, nor does it automatically expose any of the existing persistent state to the server. For instance, neither[\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3") nor [\[WEB-TRANSPORT-HTTP2\]](#biblio-web-transport-http2 "WebTransport over HTTP/2") send cookies or support HTTP authentication or caching invalidation mechanisms. Since they do use TLS, they inherit TLS persistent state such as TLS session tickets, which while not visible to passive network observers, could be used by the server to correlate different connections from the same client.

### 14.3\. Protocol Security[](#protocol-security)

WebTransport imposes a set of requirements as described in[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework"), including:

1. Ensuring that the remote server is aware that the WebTransport protocol is in use and confirming that the remote server is willing to use the WebTransport protocol. [\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3") uses a combination of ALPN [\[RFC7301\]](#biblio-rfc7301 "Transport Layer Security (TLS) Application-Layer Protocol Negotiation Extension"), an HTTP/3 setting, and a `:protocol` [pseudo-header](#pseudo-header) to identify the WebTransport protocol. [\[WEB-TRANSPORT-HTTP2\]](#biblio-web-transport-http2 "WebTransport over HTTP/2") uses a combination of ALPN, an HTTP/2 setting, and a `:protocol` [pseudo-header](#pseudo-header) to identify the WebTransport protocol.
2. Allowing the server to filter connections based on the origin of the resource originating the transport session. The [Origin](https://fetch.spec.whatwg.org/#http-origin) header field on the session establishment request carries this information.

Protocol security related considerations are described in the_Security Considerations_ sections of[\[WEB-TRANSPORT-OVERVIEW\]](#biblio-web-transport-overview "WebTransport Protocol Framework") [Section 6](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview#section-6),[\[WEB-TRANSPORT-HTTP3\]](#biblio-web-transport-http3 "WebTransport over HTTP/3") [Section 8](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3#section-8), and[\[WEB-TRANSPORT-HTTP2\]](#biblio-web-transport-http2 "WebTransport over HTTP/2") [Section 9](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http2#section-9).

Networking APIs can be commonly used to scan the local network for available hosts, and thus be used for fingerprinting and other forms of attacks. WebTransport follows the [WebSocket approach](https://websockets.spec.whatwg.org/#feedback-from-the-protocol)to this problem: the specific connection error is not returned until an endpoint is verified to be a WebTransport endpoint; thus, the Web application cannot distinguish between a non-existing endpoint and the endpoint that is not willing to accept connections from the Web.

### 14.4\. Authentication using Certificate Hashes[](#certificate-hashes)

Normally, a user agent authenticates a TLS connection between itself and a remote endpoint by verifying the validity of the TLS server certificate provided against the server name in the URL [\[RFC9525\]](#biblio-rfc9525 "Service Identity in TLS"). This is accomplished by chaining server certificates to one of the trust anchors maintained by the user agent; the trust anchors in question are responsible for authenticating the server names in the certificates. We will refer to this system as Web PKI.

This API provides web applications with a capability to connect to a remote network endpoint authenticated by a specific server certificate, rather than its server name. This mechanism enables connections to endpoints for which getting long-term certificates can be challenging, including hosts that are ephemeral in nature (e.g. short-lived virtual machines), or that are not publicly routable. Since this mechanism substitutes Web PKI-based authentication for an individual connection, we need to compare the security properties of both.

A remote server will be able to successfully perform a TLS handshake only if it posesses the private key corresponding to the public key of the certificate specified. The API identifies the certificates using their hashes. That is only secure as long as the cryptographic hash function used has second-preimage resistance. The only function defined in this document is SHA-256; the API provides a way to introduce new hash functions through allowing multiple algorithm-hash pairs to be specified.

It is important to note that Web PKI provides additional security mechanisms in addition to simply establishing a chain of trust for a server name. One of them is handling certificate revocation. In cases where the certificate used is ephemeral, such a mechanism is not necessary. In other cases, the Web application has to consider the mechanism by which the certificate hashes are provisioned; for instance, if the hash is provided as a cached HTTP resource, the cache needs to be invalidated if the corresponding certificate has been rotated due to compromise. Another security feature provided by the Web PKI are safeguards against certain issues with key generation, such as rejecting certificates with known weak keys; while this specification does not provide any specific guidance, browsers MAY reject those as a part of implementation-defined behavior.

Web PKI enforces an expiry period requirement on the certificates. This requirement limits the scope of potential key compromise; it also forces server operators to design systems that support and actively perform key rotation. For this reason, WebTransport imposes a similar expiry requirement; as the certificates are expected to be ephemeral or short-lived, the expiry period is limited to two weeks. The two weeks limit is a balance between setting the expiry limit as low as possible to minimize consequences of a key compromise, and maintaining it sufficiently high to accomodate for clock skew across devices, and to lower the costs of synchronizing certificates between the client and the server side.

The WebTransport API lets the application specify multiple certificate hashes at once, allowing the client to accept multiple certificates for a period in which a new certificate is being rolled out.

Unlike a similar mechanism in [WebRTC](https://w3c.github.io/webappsec-csp/#webrtc), the server certificate hash API in WebTransport does not provide any means of authenticating the client; the fact that the client knows what the server certificate is or how to contact it is not sufficient. The application has to establish the identity of the client in-band if necessary.

### 14.5\. Fingerprinting and Tracking[](#fingerprinting)

This API provides sites with the ability to generate network activity and closely observe the effect of this activity. The information obtained in this way might be [identifying](https://infra.spec.whatwg.org/#tracking-vector).

It is important to recognize that very similar networking capabilities are provided by other web platform APIs (such as [fetch](https://fetch.spec.whatwg.org/#concept-fetch) and [\[webrtc\]](#biblio-webrtc "WebRTC: Real-Time Communication in Browsers")). The net adverse effect on privacy due to adding WebTransport is therefore minimal. The considerations in this section applies equally to other networking capabilities.

Measuring network characteristics requires that the network be used and that the effect of that usage be measured, both of which are enabled by this API. WebTransport provides sites with an ability to generate network activity toward a server of their choice and observe the effects. Observations of both the stable properties of a network path and dynamic effect of network usage are possible.

Information about the network is available to the server either directly through its own networking stack, indirectly through the rate at which data is consumed or transmitted by the client, or as part of the statistics provided by the API (see [§ 6.13 WebTransportConnectionStats Dictionary](#web-transport-connection-stats)). Consequently, restrictions on information in user agents is not the only mechanism that might be needed to manage these privacy risks.

#### 14.5.1\. Static Observations[](#fp-static)

A site can observe available network capacity or round trip time (RTT) between a user agent and a chosen server. This information can be identifying when combined with other tracking vectors. RTT can also reveal something about the physical location of a user agent, especially if multiple measurements can be made from multiple vantage points.

Though networking is shared, network use is often sporadic, which means that sites are often able to observe the capacity and round trip times of an uncontested or lightly loaded network path. These properties are stable for many people as their network location does not change and the position of network bottlenecks--which determine available capacity--can be close to a user agent.

#### 14.5.2\. Shared Networking[](#fp-shared)

Contested links present sites with opportunities to enable[cross-site recognition](https://w3ctag.github.io/privacy-principles/#dfn-cross-site-recognition), which might be used to perform unsanctioned tracking [\[UNSANCTIONED-TRACKING\]](#biblio-unsanctioned-tracking "Unsanctioned Web Tracking"). Network capacity is a finite shared resource, so a user agent that concurrently accesses different sites might reveal a connection between the identity presented to each site.

The use of networking capabilities on one site reduces the capacity available to other sites, which can be observed using networking APIs. Network usage and metrics can change dynamically, so any change can be observed in real time. This might allow sites to increase confidence that activity on different sites originates from the same user.

A user agent could limit or degrade access to feedback mechanisms such as statistics ([§ 6.13 WebTransportConnectionStats Dictionary](#web-transport-connection-stats)) for sites that are inactive or do not have focus ([HTML § 6.6 Focus](https://html.spec.whatwg.org/multipage/interaction.html#focus)). As noted, this does not prevent a server from making observations about changes in the network.

#### 14.5.3\. Pooled Sessions[](#fp-pooled)

Similar to shared networking scenarios, when sessions are pooled on a single connection, information from one session is affected by the activity of another session. One session could infer information about the activity of another session, such as the rate at which another application is sending data.

The use of a shared connection already allows the server to correlate sessions. Use of a [network partition key](https://fetch.spec.whatwg.org/#network-partition-keys) disables pooling where use of a shared session might enable unwanted cross-site recognition.

## 15\. Examples[](#examples)

### 15.1\. Sending a buffer of datagrams[](#example-datagrams)

_This section is non-normative._

Sending a buffer of datagrams can be achieved by using the`[datagrams](#dom-webtransport-datagrams)`' `[createWritable](#dom-webtransportdatagramduplexstream-createwritable)`method and the resulting stream’s writer. In the following example datagrams are only sent if the transport is ready to send.

[](#example-1c1ce204)async function sendDatagrams(url, datagrams) {
  const wt = new WebTransport(url);
  const writable = wt.datagrams.createWritable();
  const writer = writable.getWriter();
  for (const bytes of datagrams) {
    await writer.ready;
    writer.write(bytes).catch(() => {});
  }
  await writer.close();
}

### 15.2\. Sending datagrams at a fixed rate[](#example-fixed-rate)

_This section is non-normative._

Sending datagrams at a fixed rate regardless if the transport is ready to send can be achieved by simply using `[datagrams](#dom-webtransport-datagrams)`'`[createWritable](#dom-webtransportdatagramduplexstream-createwritable)` method and the resulting stream’s writer without awaiting the `ready` attribute.

[](#example-3dc51cda)// Sends datagrams every 100 ms.
async function sendFixedRate(url, createDatagram, ms = 100) {
  const wt = new WebTransport(url);
  const writable = wt.datagrams.createWritable();
  const writer = writable.getWriter();
  const bytes = createDatagram();
  setInterval(() => writer.write(bytes).catch(() => {}), ms);
}

### 15.3\. Receiving datagrams[](#example-receiving-datagrams)

_This section is non-normative._

Datagrams can be received by reading from the transport.`[datagrams](#dom-webtransport-datagrams)`.`[readable](#dom-webtransportdatagramduplexstream-readable)`attribute. Null values may indicate that packets are not being processed quickly enough.

[](#example-d871a49b)async function receiveDatagrams(url) {
  const wt = new WebTransport(url);
  for await (const datagram of wt.datagrams.readable) {
    // Process the datagram
  }
}

### 15.4\. Receiving datagrams with a BYOB reader[](#example-datagrams-byob)

_This section is non-normative._

As `[datagrams](#dom-webtransport-datagrams)` are [readable byte streams](https://streams.spec.whatwg.org/#readable-byte-stream), you can acquire a[BYOB reader](https://streams.spec.whatwg.org/#byob-reader) for them, which allows more precise control over buffer allocation in order to avoid copies. This example reads the datagram into a 64 kibibytes memory buffer.

[](#example-31327a9a)const wt = new WebTransport(url);

for await (const datagram of wt.datagrams.readable) {
  const reader = datagram.getReader({ mode: "byob" });

  let array_buffer = new ArrayBuffer(65536);
  const buffer = await readInto(array_buffer);
}

async function readInto(buffer) {
  let offset = 0;

  while (offset < buffer.byteLength) {
    const {value: view, done} = await reader.read(
        new Uint8Array(buffer, offset, buffer.byteLength - offset));
    buffer = view.buffer;
    if (done) {
      break;
    }
    offset += view.byteLength;
  }

  return buffer;
}

### 15.5\. Sending a stream[](#example-sending-stream)

_This section is non-normative._

Sending data as a one-way stream can be achieved by using the`[createUnidirectionalStream](#dom-webtransport-createunidirectionalstream)` function and the resulting stream’s writer.

The written chunk boundaries aren’t preserved on reception, as the bytes might coalesce on the wire. Applications are therefore encouraged to provide their own framing.

[](#example-72df6ceb)async function sendData(url, ...data) {
  const wt = new WebTransport(url);
  const writable = await wt.createUnidirectionalStream();
  const writer = writable.getWriter();
  for (const bytes of data) {
    await writer.ready;
    writer.write(bytes).catch(() => {});
  }
  await writer.close();
}

The streams spec[discourages](https://streams.spec.whatwg.org/#example-manual-write-dont-await) awaiting the promise from write().

Encoding can also be done through pipes from a `[ReadableStream](https://streams.spec.whatwg.org/#readablestream)`, for example using`[TextEncoderStream](https://encoding.spec.whatwg.org/#textencoderstream)`.

[](#example-14e60a4e)async function sendText(url, readableStreamOfTextData) {
  const wt = new WebTransport(url);
  const writable = await wt.createUnidirectionalStream();
  await readableStreamOfTextData
    .pipeThrough(new TextEncoderStream("utf-8"))
    .pipeTo(writable);
}

### 15.6\. Receiving incoming streams[](#example-receiving-incoming-streams)

_This section is non-normative._

Reading incoming streams can be achieved by iterating over the`[incomingUnidirectionalStreams](#dom-webtransport-incomingunidirectionalstreams)` attribute, and then consuming each `[WebTransportReceiveStream](#webtransportreceivestream)` by iterating over its chunks.

Chunking is determined by the user agent, not the sender.

[](#example-53f87595)async function receiveData(url, processTheData) {
  const wt = new WebTransport(url);
  for await (const readable of wt.incomingUnidirectionalStreams) {
    // consume streams individually using IFFEs, reporting per-stream errors
    ((async () => {
      try {
        for await (const bytes of readable) {
          processTheData(bytes);
        }
      } catch (e) {
        console.error(e);
      }
    })());
  }
}

Decoding can also be done through pipes to new WritableStreams, for example using`[TextDecoderStream](https://encoding.spec.whatwg.org/#textdecoderstream)`. This example assumes text output should not be interleaved, and therefore only reads one stream at a time.

[](#example-b6b74950)async function receiveText(url, createWritableStreamForTextData) {
  const wt = new WebTransport(url);
  for await (const readable of wt.incomingUnidirectionalStreams) {
    // consume sequentially to not interleave output, reporting per-stream errors
    try {
      await readable
       .pipeThrough(new TextDecoderStream("utf-8"))
       .pipeTo(createWritableStreamForTextData());
    } catch (e) {
      console.error(e);
    }
  }
}

### 15.7\. Receiving a stream with a BYOB reader[](#example-stream-byob)

_This section is non-normative._

As `[WebTransportReceiveStream](#webtransportreceivestream)`s are [readable byte streams](https://streams.spec.whatwg.org/#readable-byte-stream), you can acquire a[BYOB reader](https://streams.spec.whatwg.org/#byob-reader) for them, which allows more precise control over buffer allocation in order to avoid copies. This example reads the first 1024 bytes from a`[WebTransportReceiveStream](#webtransportreceivestream)` into a single memory buffer.

[](#example-0f095ca1)const wt = new WebTransport(url);

const reader = wt.incomingUnidirectionalStreams.getReader();
const { value: recv_stream, done } = await reader.read();
const byob_reader = recv_stream.getReader({ mode: "byob" });

let array_buffer = new ArrayBuffer(1024);
const buffer = await readInto(array_buffer);

async function readInto(buffer) {
  let offset = 0;

  while (offset < buffer.byteLength) {
    const {value: view, done} = await reader.read(
        new Uint8Array(buffer, offset, buffer.byteLength - offset));
    buffer = view.buffer;
    if (done) {
      break;
    }
    offset += view.byteLength;
  }

  return buffer;
}

### 15.8\. Sending a transactional chunk on a stream[](#example-transactional-stream)

_This section is non-normative._

Sending a transactional piece of data on a unidirectional stream, only if it can be done entirely without blocking on [flow control](#stream-signal-flow-control), can be achieved by using the`[getWriter](#dom-webtransportsendstream-getwriter)` function and the resulting writer.

[](#example-6d23bcbc)async function sendTransactionalData(wt, bytes) {
  const writable = await wt.createUnidirectionalStream();
  const writer = writable.getWriter();
  await writer.ready;
  try {
    await writer.atomicWrite(bytes);
  } catch (e) {
    if (e.name != "AbortError") throw e;
    // rejected to avoid blocking on flow control
    // The writable remains un-errored provided no non-atomic writes are pending
  } finally {
    writer.releaseLock();
  }
}

### 15.9\. Using a server certificate hash[](#example-server-certificate-hash)

_This section is non-normative._

A WebTransport session can override the default trust evaluation performed by the client with a check against the hash of the certificate provided to the server. In the example below, `hashValue` is a `[BufferSource](https://webidl.spec.whatwg.org/#BufferSource)` containing the SHA-256 hash of a server certificate that the [underlying connection](#underlying-connection) should consider to be valid.

[](#example-ae6f59b0)const wt = new WebTransport(url, {
  serverCertificateHashes: [
    {
      algorithm: "sha-256",
      value: hashValue,
    }
  ]
});
await wt.ready;

### 15.10\. Complete example[](#example-complete)

_This section is non-normative._

This example illustrates use of the closed and ready promises, opening of uni-directional and bi-directional streams by either the client or the server, and sending and receiving datagrams.

The `writable` attribute that used to exist on a transport’s `[datagrams](#dom-webtransport-datagrams)` is easy to polyfill as follows:

wt.datagrams.writable ||= wt.datagrams.createWritable();

[](#example-7094a8cf)// Adds an entry to the event log on the page, optionally applying a specified
// CSS class.

let wt, streamNumber, datagramWriter;

connect.onclick = async () => {
  try {
    const url = document.getElementById('url').value;

    wt = new WebTransport(url);
    wt.datagrams.writable ||= wt.datagrams.createWritable();
    addToEventLog('Initiating connection...');
    await wt.ready;
    addToEventLog(`${(wt.reliability == "reliable-only")? "TCP" : "UDP"} ` +
                  `connection ready.`);
    wt.closed
      .then(() => addToEventLog('Connection closed normally.'))
      .catch(() => addToEventLog('Connection closed abruptly.', 'error'));

    streamNumber = 1;
    datagramWriter = wt.datagrams.writable.getWriter();

    readDatagrams();
    acceptUnidirectionalStreams();
    document.forms.sending.elements.send.disabled = false;
    document.getElementById('connect').disabled = true;
  } catch (e) {
    addToEventLog(`Connection failed. ${e}`, 'error');
  }
}

sendData.onclick = async () => {
  const form = document.forms.sending.elements;
  const data = sending.data.value;
  const bytes = new TextEncoder('utf-8').encode(data);
  try {
    switch (form.sendtype.value) {
      case 'datagram': {
        await datagramWriter.ready;
        datagramWriter.write(bytes).catch(() => {});
        addToEventLog(`Sent datagram: ${data}`);
        break;
      }
      case 'unidi': {
        const writable = await wt.createUnidirectionalStream();
        const writer = writable.getWriter();
        writer.write(bytes).catch(() => {});
        await writer.close();
        addToEventLog(`Sent a unidirectional stream with data: ${data}`);
        break;
      }
      case 'bidi': {
        const duplexStream = await wt.createBidirectionalStream();
        const n = streamNumber++;
        readFromIncomingStream(duplexStream.readable, n);

        const writer = duplexStream.writable.getWriter();
        writer.write(bytes).catch(() => {});
        await writer.close();
        addToEventLog(`Sent bidirectional stream #${n} with data: ${data}`);
        break;
      }
    }
  } catch (e) {
    addToEventLog(`Error while sending data: ${e}`, 'error');
  }
}

// Reads datagrams into the event log until EOF is reached.
async function readDatagrams() {
  try {
    const decoder = new TextDecoderStream('utf-8');

    for await (const data of wt.datagrams.readable.pipeThrough(decoder)) {
      addToEventLog(`Datagram received: ${data}`);
    }
    addToEventLog('Done reading datagrams!');
  } catch (e) {
    addToEventLog(`Error while reading datagrams: ${e}`, 'error');
  }
}

async function acceptUnidirectionalStreams() {
  try {
    for await (const readable of wt.incomingUnidirectionalStreams) {
      const number = streamNumber++;
      addToEventLog(`New incoming unidirectional stream #${number}`);
      readFromIncomingStream(readable, number);
    }
    addToEventLog('Done accepting unidirectional streams!');
  } catch (e) {
    addToEventLog(`Error while accepting streams ${e}`, 'error');
  }
}

async function readFromIncomingStream(readable, number) {
  try {
    const decoder = new TextDecoderStream('utf-8');
    for await (const data of readable.pipeThrough(decoder)) {
      addToEventLog(`Received data on stream #${number}: ${data}`);
    }
    addToEventLog(`Stream #${number} closed`);
  } catch (e) {
    addToEventLog(`Error while reading from stream #${number}: ${e}`, 'error');
    addToEventLog(`    ${e.message}`);
  }
}

function addToEventLog(text, severity = 'info') {
  const log = document.getElementById('event-log');
  const previous = log.lastElementChild;
  const entry = document.createElement('li');
  entry.innerText = text;
  entry.className = `log-${severity}`;
  log.appendChild(entry);

  // If the previous entry in the log was visible, scroll to the new element.
  if (previous &&
      previous.getBoundingClientRect().top < log.getBoundingClientRect().bottom) {
    entry.scrollIntoView();
  }
}

## 16\. Acknowledgements[](#acknowledgements)

The editors wish to thank the Working Group chairs and Team Contact, Jan-Ivar Bruaroey, Will Law and Yves Lafon, for their support.

The `[WebTransport](#webtransport)` interface is based on the `QuicTransport` interface initially described in the [W3C ORTC CG](https://www.w3.org/community/ortc/), and has been adapted for use in this specification.

## Index[](#index)

### Terms defined by this specification[](#index-defined-here)

* [abort](#webtransportsendstream-abort), in § 7.4
* [abort all atomic write requests](#webtransportsendstream-abort-all-atomic-write-requests), in § 7.4
* [abort receiving](#stream-abort-receiving), in § 3.2
* [abort sending](#stream-abort-sending), in § 3.2
* [algorithm](#dom-webtransporthash-algorithm), in § 6.9
* [allowed public key algorithms](#allowed-public-key-algorithms), in § 6.9
* [allowPooling](#dom-webtransportoptions-allowpooling), in § 6.9
* [\[\[AnticipatedConcurrentIncomingBidirectionalStreams\]\]](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams-slot), in § 6.1
* anticipatedConcurrentIncomingBidirectionalStreams  
   * [attribute for WebTransport](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams), in § 6.3  
   * [dict-member for WebTransportOptions](#dom-webtransportoptions-anticipatedconcurrentincomingbidirectionalstreams), in § 6.9
* [\[\[AnticipatedConcurrentIncomingUnidirectionalStreams\]\]](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams-slot), in § 6.1
* anticipatedConcurrentIncomingUnidirectionalStreams  
   * [attribute for WebTransport](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams), in § 6.3  
   * [dict-member for WebTransportOptions](#dom-webtransportoptions-anticipatedconcurrentincomingunidirectionalstreams), in § 6.9
* [atomicWrite()](#dom-webtransportwriter-atomicwrite), in § 11.1
* [atomicWrite(chunk)](#dom-webtransportwriter-atomicwrite), in § 11.1
* [\[\[AtomicWriteRequests\]\]](#dom-webtransportsendstream-atomicwriterequests-slot), in § 7.3
* [atSendCapacity](#dom-webtransportconnectionstats-atsendcapacity), in § 6.13
* [bidirectional](#stream-bidirectional), in § 3.2
* bytesAcknowledged  
   * [dict-member for WebTransportConnectionStats](#dom-webtransportconnectionstats-bytesacknowledged), in § 6.13  
   * [dict-member for WebTransportSendStreamStats](#dom-webtransportsendstreamstats-bytesacknowledged), in § 7.6
* [bytesLost](#dom-webtransportconnectionstats-byteslost), in § 6.13
* [bytesRead](#dom-webtransportreceivestreamstats-bytesread), in § 9.5
* bytesReceived  
   * [dict-member for WebTransportConnectionStats](#dom-webtransportconnectionstats-bytesreceived), in § 6.13  
   * [dict-member for WebTransportReceiveStreamStats](#dom-webtransportreceivestreamstats-bytesreceived), in § 9.5
* bytesSent  
   * [dict-member for WebTransportConnectionStats](#dom-webtransportconnectionstats-bytessent), in § 6.13  
   * [dict-member for WebTransportSendStreamStats](#dom-webtransportsendstreamstats-bytessent), in § 7.6
* [bytesSentOverhead](#dom-webtransportconnectionstats-bytessentoverhead), in § 6.13
* [\[\[BytesWritten\]\]](#dom-webtransportsendstream-byteswritten-slot), in § 7.3
* [bytesWritten](#dom-webtransportsendstreamstats-byteswritten), in § 7.6
* [cancel](#webtransportreceivestream-cancel), in § 9.3
* [cleanup](#webtransport-cleanup), in § 6.5
* [close](#webtransportsendstream-close), in § 7.4
* [close()](#dom-webtransport-close), in § 6.4
* [close(closeInfo)](#dom-webtransport-close), in § 6.4
* [closeCode](#dom-webtransportcloseinfo-closecode), in § 6.10
* [\[\[Closed\]\]](#dom-webtransport-closed-slot), in § 6.1
* [closed](#dom-webtransport-closed), in § 6.3
* [commit()](#dom-webtransportwriter-commit), in § 11.1
* [\[\[CommittedOffset\]\]](#dom-webtransportsendstream-committedoffset-slot), in § 7.3
* [compute a certificate hash](#compute-a-certificate-hash), in § 6.9
* [\[\[CongestionControl\]\]](#dom-webtransport-congestioncontrol-slot), in § 6.1
* congestionControl  
   * [attribute for WebTransport](#dom-webtransport-congestioncontrol), in § 6.3  
   * [dict-member for WebTransportOptions](#dom-webtransportoptions-congestioncontrol), in § 6.9
* [CONNECT stream](#connect-stream), in § 6.2
* [constructor()](#dom-webtransporterror-webtransporterror), in § 12.2
* [constructor(message)](#dom-webtransporterror-webtransporterror), in § 12.2
* [constructor(message, options)](#dom-webtransporterror-webtransporterror), in § 12.2
* [constructor(url)](#dom-webtransport-webtransport), in § 6
* [constructor(url, options)](#dom-webtransport-webtransport), in § 6
* [context cleanup steps](#context-cleanup-steps), in § 6.7
* create  
   * [dfn for BidirectionalStream](#bidirectionalstream-create), in § 10.3  
   * [dfn for WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream-create), in § 5.1  
   * [dfn for WebTransportDatagramsWritable](#webtransportdatagramswritable-create), in § 4.1  
   * [dfn for WebTransportReceiveStream](#webtransportreceivestream-create), in § 9.3  
   * [dfn for WebTransportSendGroup](#webtransportsendgroup-create), in § 8.3  
   * [dfn for WebTransportSendStream](#webtransportsendstream-create), in § 7.4  
   * [dfn for WebTransportWriter](#webtransportwriter-create), in § 11.2
* [create a bidirectional stream](#session-create-a-bidirectional-stream), in § 3.1
* [create an outgoing unidirectional stream](#session-create-an-outgoing-unidirectional-stream), in § 3.1
* [createBidirectionalStream()](#dom-webtransport-createbidirectionalstream), in § 6.4
* [createBidirectionalStream(options)](#dom-webtransport-createbidirectionalstream), in § 6.4
* [createSendGroup()](#dom-webtransport-createsendgroup), in § 6.4
* [createUnidirectionalStream()](#dom-webtransport-createunidirectionalstream), in § 6.4
* [createUnidirectionalStream(options)](#dom-webtransport-createunidirectionalstream), in § 6.4
* [createWritable()](#dom-webtransportdatagramduplexstream-createwritable), in § 5.2
* [createWritable(options)](#dom-webtransportdatagramduplexstream-createwritable), in § 5.2
* creating  
   * [dfn for WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream-create), in § 5.1  
   * [dfn for WebTransportDatagramsWritable](#webtransportdatagramswritable-create), in § 4.1  
   * [dfn for WebTransportReceiveStream](#webtransportreceivestream-create), in § 9.3  
   * [dfn for WebTransportSendGroup](#webtransportsendgroup-create), in § 8.3  
   * [dfn for WebTransportSendStream](#webtransportsendstream-create), in § 7.4  
   * [dfn for WebTransportWriter](#webtransportwriter-create), in § 11.2
* [custom certificate requirements](#custom-certificate-requirements), in § 6.9
* [\[\[Datagrams\]\]](#dom-webtransport-datagrams-slot), in § 6.1
* datagrams  
   * [attribute for WebTransport](#dom-webtransport-datagrams), in § 6.3  
   * [dict-member for WebTransportConnectionStats](#dom-webtransportconnectionstats-datagrams), in § 6.13
* [datagramsReadableType](#dom-webtransportoptions-datagramsreadabletype), in § 6.9
* ["default"](#dom-webtransportcongestioncontrol-default), in § 6.9
* [\[\[Draining\]\]](#dom-webtransport-draining-slot), in § 6.1
* draining  
   * [attribute for WebTransport](#dom-webtransport-draining), in § 6.3  
   * [dfn for session](#session-draining), in § 3.1
* [droppedIncoming](#dom-webtransportdatagramstats-droppedincoming), in § 6.14
* [establish](#session-establish), in § 6.2
* [estimatedSendRate](#dom-webtransportconnectionstats-estimatedsendrate), in § 6.13
* [expiredIncoming](#dom-webtransportdatagramstats-expiredincoming), in § 6.14
* [expiredOutgoing](#dom-webtransportdatagramstats-expiredoutgoing), in § 6.14
* [exportKeyingMaterial(label)](#dom-webtransport-exportkeyingmaterial), in § 6.4
* [exportKeyingMaterial(label, context)](#dom-webtransport-exportkeyingmaterial), in § 6.4
* [flow control](#stream-signal-flow-control), in § 3.2
* getStats()  
   * [method for WebTransport](#dom-webtransport-getstats), in § 6.4  
   * [method for WebTransportReceiveStream](#dom-webtransportreceivestream-getstats), in § 9.1  
   * [method for WebTransportSendGroup](#dom-webtransportsendgroup-getstats), in § 8.1  
   * [method for WebTransportSendStream](#dom-webtransportsendstream-getstats), in § 7.2
* [getWriter()](#dom-webtransportsendstream-getwriter), in § 7.2
* [grouped](#grouped), in § 8
* [\[\[IncomingBidirectionalStreams\]\]](#dom-webtransport-incomingbidirectionalstreams-slot), in § 6.1
* [incomingBidirectionalStreams](#dom-webtransport-incomingbidirectionalstreams), in § 6.3
* [\[\[IncomingDatagramsExpirationDuration\]\]](#dom-webtransportdatagramduplexstream-incomingdatagramsexpirationduration-slot), in § 5.1
* [\[\[IncomingDatagramsHighWaterMark\]\]](#dom-webtransportdatagramduplexstream-incomingdatagramshighwatermark-slot), in § 5.1
* [\[\[IncomingDatagramsPullPromise\]\]](#dom-webtransportdatagramduplexstream-incomingdatagramspullpromise-slot), in § 5.1
* [\[\[IncomingDatagramsQueue\]\]](#dom-webtransportdatagramduplexstream-incomingdatagramsqueue-slot), in § 5.1
* [incomingHighWaterMark](#dom-webtransportdatagramduplexstream-incominghighwatermark), in § 5.3
* [incomingMaxAge](#dom-webtransportdatagramduplexstream-incomingmaxage), in § 5.3
* [incoming unidirectional](#stream-incoming-unidirectional), in § 3.2
* [\[\[IncomingUnidirectionalStreams\]\]](#dom-webtransport-incomingunidirectionalstreams-slot), in § 6.1
* [incomingUnidirectionalStreams](#dom-webtransport-incomingunidirectionalstreams), in § 6.3
* \[\[InternalStream\]\]  
   * [attribute for WebTransportReceiveStream](#dom-webtransportreceivestream-internalstream-slot), in § 9.2  
   * [attribute for WebTransportSendStream](#dom-webtransportsendstream-internalstream-slot), in § 7.3
* [lostOutgoing](#dom-webtransportdatagramstats-lostoutgoing), in § 6.14
* ["low-latency"](#dom-webtransportcongestioncontrol-low-latency), in § 6.9
* [maxDatagramSize](#dom-webtransportdatagramduplexstream-maxdatagramsize), in § 5.3
* [minRtt](#dom-webtransportconnectionstats-minrtt), in § 6.13
* [\[\[NewConnection\]\]](#dom-webtransport-newconnection-slot), in § 6.1
* [obtain a WebTransport connection](#obtain-a-webtransport-connection), in § 6.2
* [\[\[OutgoingDatagramsExpirationDuration\]\]](#dom-webtransportdatagramduplexstream-outgoingdatagramsexpirationduration-slot), in § 5.1
* [\[\[OutgoingDatagramsHighWaterMark\]\]](#dom-webtransportdatagramduplexstream-outgoingdatagramshighwatermark-slot), in § 5.1
* [\[\[OutgoingDatagramsQueue\]\]](#dom-webtransportdatagramswritable-outgoingdatagramsqueue-slot), in § 4.1
* [outgoingHighWaterMark](#dom-webtransportdatagramduplexstream-outgoinghighwatermark), in § 5.3
* [outgoingMaxAge](#dom-webtransportdatagramduplexstream-outgoingmaxage), in § 5.3
* [\[\[OutgoingMaxDatagramSize\]\]](#dom-webtransportdatagramduplexstream-outgoingmaxdatagramsize-slot), in § 5.1
* [outgoing unidirectional](#stream-outgoing-unidirectional), in § 3.2
* [packetsLost](#dom-webtransportconnectionstats-packetslost), in § 6.13
* [packetsReceived](#dom-webtransportconnectionstats-packetsreceived), in § 6.13
* [packetsSent](#dom-webtransportconnectionstats-packetssent), in § 6.13
* ["pending"](#dom-webtransportreliabilitymode-pending), in § 6
* [\[\[PendingOperation\]\]](#dom-webtransportsendstream-pendingoperation-slot), in § 7.3
* [process a WebTransport fetch response](#process-a-webtransport-fetch-response), in § 6.2
* [\[\[Protocol\]\]](#dom-webtransport-protocol-slot), in § 6.1
* [protocol](#dom-webtransport-protocol), in § 6.3
* [protocol names](#protocol-names), in § 6.9
* [protocols](#dom-webtransportoptions-protocols), in § 6.9
* [pseudo-header](#pseudo-header), in § 6.2
* [pullBidirectionalStream](#pullbidirectionalstream), in § 6.2
* [pull bytes](#webtransportreceivestream-pull-bytes), in § 9.3
* [pullDatagrams](#pulldatagrams), in § 5.4
* [pullUnidirectionalStream](#pullunidirectionalstream), in § 6.2
* [queue a network task](#webtransport-queue-a-network-task), in § 6.5
* \[\[Readable\]\]  
   * [attribute for WebTransportBidirectionalStream](#dom-webtransportbidirectionalstream-readable-slot), in § 10.1  
   * [attribute for WebTransportDatagramDuplexStream](#dom-webtransportdatagramduplexstream-readable-slot), in § 5.1
* readable  
   * [attribute for WebTransportBidirectionalStream](#dom-webtransportbidirectionalstream-readable), in § 10.2  
   * [attribute for WebTransportDatagramDuplexStream](#dom-webtransportdatagramduplexstream-readable), in § 5.3
* [\[\[ReadableType\]\]](#dom-webtransportdatagramduplexstream-readabletype-slot), in § 5.1
* [\[\[Ready\]\]](#dom-webtransport-ready-slot), in § 6.1
* [ready](#dom-webtransport-ready), in § 6.3
* [reason](#dom-webtransportcloseinfo-reason), in § 6.10
* [receive](#stream-receive), in § 3.2
* [receive a bidirectional stream](#session-receive-a-bidirectional-stream), in § 3.1
* [receive a datagram](#session-receive-a-datagram), in § 3.1
* [receive an incoming unidirectional stream](#session-receive-an-incoming-unidirectional-stream), in § 3.1
* [receiveDatagrams](#receivedatagrams), in § 5.4
* [\[\[ReceiveStreams\]\]](#dom-webtransport-receivestreams-slot), in § 6.1
* [receiving aborted](#stream-signal-receiving-aborted), in § 3.2
* [\[\[Reliability\]\]](#dom-webtransport-reliability-slot), in § 6.1
* [reliability](#dom-webtransport-reliability), in § 6.3
* ["reliable-only"](#dom-webtransportreliabilitymode-reliable-only), in § 6
* [\[\[RequireUnreliable\]\]](#dom-webtransport-requireunreliable-slot), in § 6.1
* [requireUnreliable](#dom-webtransportoptions-requireunreliable), in § 6.9
* [rttVariation](#dom-webtransportconnectionstats-rttvariation), in § 6.13
* [send](#stream-send), in § 3.2
* [send a datagram](#session-send-a-datagram), in § 3.1
* [sendDatagrams](#senddatagrams), in § 4.3
* \[\[SendGroup\]\]  
   * [attribute for WebTransportDatagramsWritable](#dom-webtransportdatagramswritable-sendgroup-slot), in § 4.1  
   * [attribute for WebTransportSendStream](#dom-webtransportsendstream-sendgroup-slot), in § 7.3
* sendGroup  
   * [attribute for WebTransportDatagramsWritable](#dom-webtransportdatagramswritable-sendgroup), in § 4.2  
   * [attribute for WebTransportSendStream](#dom-webtransportsendstream-sendgroup), in § 7.1  
   * [dict-member for WebTransportSendOptions](#dom-webtransportsendoptions-sendgroup), in § 6.11
* [sending aborted](#stream-signal-sending-aborted), in § 3.2
* \[\[SendOrder\]\]  
   * [attribute for WebTransportDatagramsWritable](#dom-webtransportdatagramswritable-sendorder-slot), in § 4.1  
   * [attribute for WebTransportSendStream](#dom-webtransportsendstream-sendorder-slot), in § 7.3
* sendOrder  
   * [attribute for WebTransportDatagramsWritable](#dom-webtransportdatagramswritable-sendorder), in § 4.2  
   * [attribute for WebTransportSendStream](#dom-webtransportsendstream-sendorder), in § 7.1  
   * [dict-member for WebTransportSendOptions](#dom-webtransportsendoptions-sendorder), in § 6.11
* [send-order rules](#send-order-rules), in § 4.3
* [\[\[SendStreams\]\]](#dom-webtransport-sendstreams-slot), in § 6.1
* [serverCertificateHashes](#dom-webtransportoptions-servercertificatehashes), in § 6.9
* ["session"](#dom-webtransporterrorsource-session), in § 12
* [\[\[Session\]\]](#dom-webtransport-session-slot), in § 6.1
* [smoothedRtt](#dom-webtransportconnectionstats-smoothedrtt), in § 6.13
* [\[\[Source\]\]](#dom-webtransporterror-source-slot), in § 12.1
* source  
   * [attribute for WebTransportError](#dom-webtransporterror-source), in § 12.3  
   * [dict-member for WebTransportErrorOptions](#dom-webtransporterroroptions-source), in § 12
* [\[\[State\]\]](#dom-webtransport-state-slot), in § 6.1
* ["stream"](#dom-webtransporterrorsource-stream), in § 12
* [\[\[StreamErrorCode\]\]](#dom-webtransporterror-streamerrorcode-slot), in § 12.1
* streamErrorCode  
   * [attribute for WebTransportError](#dom-webtransporterror-streamerrorcode), in § 12.3  
   * [dict-member for WebTransportErrorOptions](#dom-webtransporterroroptions-streamerrorcode), in § 12
* [strict ordering](#strict-ordering), in § 6.11
* [supportsReliableOnly](#dom-webtransport-supportsreliableonly), in § 6.3
* ["supports-unreliable"](#dom-webtransportreliabilitymode-supports-unreliable), in § 6
* [terminate](#session-terminate), in § 3.1
* [terminated](#session-terminated), in § 3.1
* ["throughput"](#dom-webtransportcongestioncontrol-throughput), in § 6.9
* \[\[Transport\]\]  
   * [attribute for WebTransportBidirectionalStream](#dom-webtransportbidirectionalstream-transport-slot), in § 10.1  
   * [attribute for WebTransportDatagramDuplexStream](#dom-webtransportdatagramduplexstream-transport-slot), in § 5.1  
   * [attribute for WebTransportDatagramsWritable](#dom-webtransportdatagramswritable-transport-slot), in § 4.1  
   * [attribute for WebTransportReceiveStream](#dom-webtransportreceivestream-transport-slot), in § 9.2  
   * [attribute for WebTransportSendGroup](#dom-webtransportsendgroup-transport-slot), in § 8.2  
   * [attribute for WebTransportSendStream](#dom-webtransportsendstream-transport-slot), in § 7.3
* [underlying connection](#underlying-connection), in § 3.1
* [value](#dom-webtransporthash-value), in § 6.9
* [verify a certificate hash](#verify-a-certificate-hash), in § 6.9
* [waitUntilAvailable](#dom-webtransportsendstreamoptions-waituntilavailable), in § 6.12
* [WebTransport](#webtransport), in § 6
* [WebTransportBidirectionalStream](#webtransportbidirectionalstream), in § 10
* [WebTransportCloseInfo](#dictdef-webtransportcloseinfo), in § 6.10
* [WebTransportCongestionControl](#enumdef-webtransportcongestioncontrol), in § 6.9
* [WebTransportConnectionStats](#dictdef-webtransportconnectionstats), in § 6.13
* [WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream), in § 5
* [WebTransportDatagramStats](#dictdef-webtransportdatagramstats), in § 6.14
* [WebTransportDatagramsWritable](#webtransportdatagramswritable), in § 4
* [WebTransportError](#webtransporterror), in § 12
* [WebTransportError()](#dom-webtransporterror-webtransporterror), in § 12.2
* [WebTransportError(message)](#dom-webtransporterror-webtransporterror), in § 12.2
* [WebTransportError(message, options)](#dom-webtransporterror-webtransporterror), in § 12.2
* [WebTransportErrorOptions](#dictdef-webtransporterroroptions), in § 12
* [WebTransportErrorSource](#enumdef-webtransporterrorsource), in § 12
* [WebTransportHash](#dictdef-webtransporthash), in § 6.9
* [WebTransportOptions](#dictdef-webtransportoptions), in § 6.9
* [WebTransportReceiveStream](#webtransportreceivestream), in § 9
* [WebTransportReceiveStreamStats](#dictdef-webtransportreceivestreamstats), in § 9.5
* [WebTransportReliabilityMode](#enumdef-webtransportreliabilitymode), in § 6
* [WebTransportSendGroup](#webtransportsendgroup), in § 8
* [WebTransportSendOptions](#dictdef-webtransportsendoptions), in § 6.11
* [WebTransportSendStream](#webtransportsendstream), in § 7
* [WebTransportSendStreamOptions](#dictdef-webtransportsendstreamoptions), in § 6.12
* [WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats), in § 7.6
* [WebTransport session](#protocol-webtransport-session), in § 3.1
* [WebTransport stream](#protocol-webtransport-stream), in § 3.2
* [WebTransport(url)](#dom-webtransport-webtransport), in § 6
* [WebTransport(url, options)](#dom-webtransport-webtransport), in § 6
* [WebTransportWriter](#webtransportwriter), in § 11
* [\[\[Writable\]\]](#dom-webtransportbidirectionalstream-writable-slot), in § 10.1
* [writable](#dom-webtransportbidirectionalstream-writable), in § 10.2
* [\[\[Writables\]\]](#dom-webtransportdatagramduplexstream-writables-slot), in § 5.1
* [write](#webtransportsendstream-write), in § 7.4
* [writeDatagrams](#writedatagrams), in § 4.3

### Terms defined by reference[](#index-defined-elsewhere)

* \[\] defines the following terms:  
   * cross-site recognition
* \[CSP3\] defines the following terms:  
   * webrtc
* \[DOM\] defines the following terms:  
   * abort reason  
   * add
* \[ECMASCRIPT-6.0\] defines the following terms:  
   * fulfilled  
   * rejected  
   * resolved  
   * settled  
   * the typed array constructors table
* \[ENCODING\] defines the following terms:  
   * TextDecoderStream  
   * TextEncoderStream  
   * UTF-8 decode  
   * UTF-8 encode
* \[FETCH\] defines the following terms:  
   * cache mode  
   * client  
   * connection  
   * credentials mode  
   * current URL  
   * destination  
   * fetch  
   * header list  
   * method  
   * mode  
   * network error  
   * network partition key  
   * obtain a connection  
   * origin  
   * origin (for request)  
   * policy container  
   * processResponse  
   * redirect mode  
   * referrer  
   * request  
   * request (for fetch record)  
   * service-workers mode  
   * set a structured field value  
   * stream  
   * URL  
   * useParallelQueue  
   * WebTransport-hash list
* \[HR-TIME-3\] defines the following terms:  
   * DOMHighResTimeStamp
* \[HTML\] defines the following terms:  
   * Serializable  
   * Transferable  
   * API base URL  
   * deserialization steps  
   * event loop  
   * in parallel  
   * networking task source  
   * origin  
   * policy container  
   * queue a global task  
   * relevant global object  
   * relevant settings object  
   * serializable object  
   * serialization steps  
   * transfer steps  
   * transfer-receiving steps
* \[INFRA\] defines the following terms:  
   * abort when  
   * append  
   * ASCII case-insensitive  
   * break  
   * byte sequence  
   * code unit prefix  
   * contain  
   * dequeue  
   * empty  
   * enqueue  
   * entry  
   * exist  
   * for each  
   * implementation-defined  
   * is empty  
   * isomorphic encode  
   * length  
   * list  
   * ordered set  
   * queue  
   * remove  
   * set  
   * set (for map)
* \[STREAMS\] defines the following terms:  
   * ReadableStream  
   * ReadableStreamType  
   * WritableStream  
   * WritableStreamDefaultWriter  
   * abort() (for WritableStream)  
   * abort() (for WritableStreamDefaultWriter)  
   * abortAlgorithm  
   * BYOB reader  
   * cancel() (for ReadableStream)  
   * cancel() (for ReadableStreamGenericReader)  
   * cancelAlgorithm  
   * close (for ReadableStream)  
   * close (for WritableStream)  
   * close() (for WritableStream)  
   * close() (for WritableStreamDefaultWriter)  
   * closeAlgorithm  
   * current BYOB request view  
   * default reader  
   * enqueue  
   * error (for ReadableStream)  
   * error (for WritableStream)  
   * getWriter()  
   * high water mark  
   * highWaterMark (for ReadableStream/set up)  
   * highWaterMark (for ReadableStream/set up with byte reading support)  
   * locked  
   * min  
   * pull from bytes  
   * pullAlgorithm (for ReadableStream/set up)  
   * pullAlgorithm (for ReadableStream/set up with byte reading support)  
   * read()  
   * readable byte stream  
   * readable stream  
   * ready  
   * set up (for ReadableStream)  
   * set up (for WritableStream)  
   * set up with byte reading support  
   * write()  
   * write(chunk)  
   * writeAlgorithm
* \[URL\] defines the following terms:  
   * fragment  
   * scheme  
   * URL parser  
   * URL record
* \[WEBIDL\] defines the following terms:  
   * AbortError  
   * ArrayBuffer  
   * BufferSource  
   * Clamp  
   * DOMException  
   * DOMString  
   * DataView  
   * EnforceRange  
   * Exposed  
   * InvalidStateError  
   * NewObject  
   * NotSupportedError  
   * Promise  
   * QuotaExceededError  
   * RangeError  
   * SecureContext  
   * SyntaxError  
   * TypeError  
   * USVString  
   * Uint8Array  
   * a promise rejected with  
   * a promise resolved with  
   * any  
   * boolean  
   * byte length  
   * code  
   * created  
   * dictionary members  
   * long long  
   * message  
   * name  
   * new  
   * reacting  
   * sequence  
   * this  
   * throw  
   * undefined  
   * underlying buffer  
   * unrestricted double  
   * unsigned long  
   * unsigned long long  
   * unsigned short  
   * upon fulfillment  
   * write

## References[](#references)

### Normative References[](#normative)

\[CSP3\]Mike West; Antonio Sartori. [Content Security Policy Level 3](https://w3c.github.io/webappsec-csp/). URL: <https://w3c.github.io/webappsec-csp/> \[DOM\]Anne van Kesteren. [DOM Standard](https://dom.spec.whatwg.org/). Living Standard. URL: <https://dom.spec.whatwg.org/> \[ECMASCRIPT-6.0\]Allen Wirfs-Brock. [ECMA-262 6th Edition, The ECMAScript 2015 Language Specification](http://www.ecma-international.org/ecma-262/6.0/index.html). URL: <http://www.ecma-international.org/ecma-262/6.0/index.html> \[ENCODING\]Anne van Kesteren. [Encoding Standard](https://encoding.spec.whatwg.org/). Living Standard. URL: <https://encoding.spec.whatwg.org/> \[FETCH\]Anne van Kesteren. [Fetch Standard](https://fetch.spec.whatwg.org/). Living Standard. URL: <https://fetch.spec.whatwg.org/> \[HR-TIME-3\]Yoav Weiss. [High Resolution Time](https://w3c.github.io/hr-time/). URL: <https://w3c.github.io/hr-time/> \[HTML\]Anne van Kesteren; et al. [HTML Standard](https://html.spec.whatwg.org/multipage/). Living Standard. URL: <https://html.spec.whatwg.org/multipage/> \[INFRA\]Anne van Kesteren; Domenic Denicola. [Infra Standard](https://infra.spec.whatwg.org/). Living Standard. URL: <https://infra.spec.whatwg.org/> \[QUIC\]Jana Iyengar; Martin Thomson. [QUIC: A UDP-Based Multiplexed and Secure Transport](https://www.rfc-editor.org/rfc/rfc9000). Proposed Standard. URL: <https://www.rfc-editor.org/rfc/rfc9000> \[QUIC-DATAGRAM\]Tommy Pauly; Eric Kinnear; David Schinazi. [An Unreliable Datagram Extension to QUIC](https://www.rfc-editor.org/rfc/rfc9221). Proposed Standard. URL: <https://www.rfc-editor.org/rfc/rfc9221> \[RFC2119\]S. Bradner. [Key words for use in RFCs to Indicate Requirement Levels](https://datatracker.ietf.org/doc/html/rfc2119). March 1997\. Best Current Practice. URL: <https://datatracker.ietf.org/doc/html/rfc2119> \[RFC3279\]L. Bassham; W. Polk; R. Housley. [Algorithms and Identifiers for the Internet X.509 Public Key Infrastructure Certificate and Certificate Revocation List (CRL) Profile](https://www.rfc-editor.org/rfc/rfc3279). April 2002\. Proposed Standard. URL: <https://www.rfc-editor.org/rfc/rfc3279> \[RFC5280\]D. Cooper; et al. [Internet X.509 Public Key Infrastructure Certificate and Certificate Revocation List (CRL) Profile](https://www.rfc-editor.org/rfc/rfc5280). May 2008\. Proposed Standard. URL: <https://www.rfc-editor.org/rfc/rfc5280> \[RFC8174\]B. Leiba. [Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words](https://www.rfc-editor.org/rfc/rfc8174). May 2017\. Best Current Practice. URL: <https://www.rfc-editor.org/rfc/rfc8174> \[RFC8422\]Y. Nir; S. Josefsson; M. Pegourie-Gonnard. [Elliptic Curve Cryptography (ECC) Cipher Suites for Transport Layer Security (TLS) Versions 1.2 and Earlier](https://www.rfc-editor.org/rfc/rfc8422). August 2018\. Proposed Standard. URL: <https://www.rfc-editor.org/rfc/rfc8422> \[RFC8441\]P. McManus. [Bootstrapping WebSockets with HTTP/2](https://httpwg.org/specs/rfc8441.html). September 2018\. Proposed Standard. URL: <https://httpwg.org/specs/rfc8441.html> \[RFC9002\]J. Iyengar, Ed.; I. Swett, Ed.. [QUIC Loss Detection and Congestion Control](https://www.rfc-editor.org/rfc/rfc9002). May 2021\. Proposed Standard. URL: <https://www.rfc-editor.org/rfc/rfc9002> \[RFC9220\]R. Hamilton. [Bootstrapping WebSockets with HTTP/3](https://httpwg.org/specs/rfc9220.html). June 2022\. Proposed Standard. URL: <https://httpwg.org/specs/rfc9220.html> \[RFC9525\]P. Saint-Andre; R. Salz. [Service Identity in TLS](https://www.rfc-editor.org/rfc/rfc9525). November 2023\. Proposed Standard. URL: <https://www.rfc-editor.org/rfc/rfc9525> \[STREAMS\]Adam Rice; et al. [Streams Standard](https://streams.spec.whatwg.org/). Living Standard. URL: <https://streams.spec.whatwg.org/> \[URL\]Anne van Kesteren. [URL Standard](https://url.spec.whatwg.org/). Living Standard. URL: <https://url.spec.whatwg.org/> \[WEB-TRANSPORT-HTTP2\]Alan Frindell; et al. [WebTransport over HTTP/2](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http2). Internet-Draft. URL: <https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http2> \[WEB-TRANSPORT-HTTP3\]Alan Frindell; Eric Kinnear; Victor Vasiliev. [WebTransport over HTTP/3](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3). Internet-Draft. URL: <https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3> \[WEB-TRANSPORT-OVERVIEW\]Victor Vasiliev. [WebTransport Protocol Framework](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview). Internet-Draft. URL: <https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview> \[WEBIDL\]Edgar Chen; Timothy Gu. [Web IDL Standard](https://webidl.spec.whatwg.org/). Living Standard. URL: <https://webidl.spec.whatwg.org/> 

### Informative References[](#informative)

\[RELIABLE-RESET\]Marten Seemann; 奥一穂. [QUIC Stream Resets with Partial Delivery](https://datatracker.ietf.org/doc/html/draft-ietf-quic-reliable-stream-reset). Internet-Draft. URL: <https://datatracker.ietf.org/doc/html/draft-ietf-quic-reliable-stream-reset> \[RFC7301\]S. Friedl; et al. [Transport Layer Security (TLS) Application-Layer Protocol Negotiation Extension](https://www.rfc-editor.org/rfc/rfc7301). July 2014\. Proposed Standard. URL: <https://www.rfc-editor.org/rfc/rfc7301> \[RFC8446\]E. Rescorla. [The Transport Layer Security (TLS) Protocol Version 1.3](https://www.rfc-editor.org/rfc/rfc8446). August 2018\. Proposed Standard. URL: <https://www.rfc-editor.org/rfc/rfc8446> \[RFC9308\]M. Kühlewind; B. Trammell. [Applicability of the QUIC Transport Protocol](https://www.rfc-editor.org/rfc/rfc9308). September 2022\. Informational. URL: <https://www.rfc-editor.org/rfc/rfc9308> \[UNSANCTIONED-TRACKING\]Mark Nottingham. [Unsanctioned Web Tracking](http://www.w3.org/2001/tag/doc/unsanctioned-tracking/). 17 July 2015\. TAG Finding. URL: <http://www.w3.org/2001/tag/doc/unsanctioned-tracking/> \[WEBRTC\]Cullen Jennings; et al. [WebRTC: Real-Time Communication in Browsers](https://w3c.github.io/webrtc-pc/). URL: <https://w3c.github.io/webrtc-pc/> 

## IDL Index[](#idl-index)

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext), [Transferable](https://html.spec.whatwg.org/multipage/structured-data.html#transferable)]
interface [WebTransportDatagramsWritable](#webtransportdatagramswritable) : [WritableStream](https://streams.spec.whatwg.org/#writablestream) {
  attribute [WebTransportSendGroup](#webtransportsendgroup)? [sendGroup](#dom-webtransportdatagramswritable-sendgroup);
  attribute [long long](https://webidl.spec.whatwg.org/#idl-long-long) [sendOrder](#dom-webtransportdatagramswritable-sendorder);
};

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface [WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream) {
  [WebTransportDatagramsWritable](#webtransportdatagramswritable) [createWritable](#dom-webtransportdatagramduplexstream-createwritable)(
      optional [WebTransportSendOptions](#dictdef-webtransportsendoptions) [options](#dom-webtransportdatagramduplexstream-createwritable-options-options) = {});
  readonly attribute [ReadableStream](https://streams.spec.whatwg.org/#readablestream) [readable](#dom-webtransportdatagramduplexstream-readable);

  readonly attribute [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long) [maxDatagramSize](#dom-webtransportdatagramduplexstream-maxdatagramsize);
  attribute [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double)? [incomingMaxAge](#dom-webtransportdatagramduplexstream-incomingmaxage);
  attribute [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double)? [outgoingMaxAge](#dom-webtransportdatagramduplexstream-outgoingmaxage);
  attribute [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double) [incomingHighWaterMark](#dom-webtransportdatagramduplexstream-incominghighwatermark);
  attribute [unrestricted double](https://webidl.spec.whatwg.org/#idl-unrestricted-double) [outgoingHighWaterMark](#dom-webtransportdatagramduplexstream-outgoinghighwatermark);
};

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface [WebTransport](#webtransport) {
  [constructor](#dom-webtransport-webtransport)([USVString](https://webidl.spec.whatwg.org/#idl-USVString) [url](#dom-webtransport-webtransport-url-options-url), optional [WebTransportOptions](#dictdef-webtransportoptions) [options](#dom-webtransport-webtransport-url-options-options) = {});

  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportConnectionStats](#dictdef-webtransportconnectionstats)> [getStats](#dom-webtransport-getstats)();
  [[NewObject](https://webidl.spec.whatwg.org/#NewObject)] [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[ArrayBuffer](https://webidl.spec.whatwg.org/#idl-ArrayBuffer)> [exportKeyingMaterial](#dom-webtransport-exportkeyingmaterial)([BufferSource](https://webidl.spec.whatwg.org/#BufferSource) [label](#dom-webtransport-exportkeyingmaterial-label-context-label), optional [BufferSource](https://webidl.spec.whatwg.org/#BufferSource) [context](#dom-webtransport-exportkeyingmaterial-label-context-context));
  readonly attribute [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[undefined](https://webidl.spec.whatwg.org/#idl-undefined)> [ready](#dom-webtransport-ready);
  readonly attribute [WebTransportReliabilityMode](#enumdef-webtransportreliabilitymode) [reliability](#dom-webtransport-reliability);
  readonly attribute [WebTransportCongestionControl](#enumdef-webtransportcongestioncontrol) [congestionControl](#dom-webtransport-congestioncontrol);
  [[EnforceRange](https://webidl.spec.whatwg.org/#EnforceRange)] attribute [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short)? [anticipatedConcurrentIncomingUnidirectionalStreams](#dom-webtransport-anticipatedconcurrentincomingunidirectionalstreams);
  [[EnforceRange](https://webidl.spec.whatwg.org/#EnforceRange)] attribute [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short)? [anticipatedConcurrentIncomingBidirectionalStreams](#dom-webtransport-anticipatedconcurrentincomingbidirectionalstreams);
  readonly attribute [DOMString](https://webidl.spec.whatwg.org/#idl-DOMString) [protocol](#dom-webtransport-protocol);

  readonly attribute [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportCloseInfo](#dictdef-webtransportcloseinfo)> [closed](#dom-webtransport-closed);
  readonly attribute [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[undefined](https://webidl.spec.whatwg.org/#idl-undefined)> [draining](#dom-webtransport-draining);
  [undefined](https://webidl.spec.whatwg.org/#idl-undefined) [close](#dom-webtransport-close)(optional [WebTransportCloseInfo](#dictdef-webtransportcloseinfo) [closeInfo](#dom-webtransport-close-closeinfo-closeinfo) = {});

  readonly attribute [WebTransportDatagramDuplexStream](#webtransportdatagramduplexstream) [datagrams](#dom-webtransport-datagrams);

  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportBidirectionalStream](#webtransportbidirectionalstream)> [createBidirectionalStream](#dom-webtransport-createbidirectionalstream)(
      optional [WebTransportSendStreamOptions](#dictdef-webtransportsendstreamoptions) [options](#dom-webtransport-createbidirectionalstream-options-options) = {});
  /* a ReadableStream of WebTransportBidirectionalStream objects */
  readonly attribute [ReadableStream](https://streams.spec.whatwg.org/#readablestream) [incomingBidirectionalStreams](#dom-webtransport-incomingbidirectionalstreams);

  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportSendStream](#webtransportsendstream)> [createUnidirectionalStream](#dom-webtransport-createunidirectionalstream)(
      optional [WebTransportSendStreamOptions](#dictdef-webtransportsendstreamoptions) [options](#dom-webtransport-createunidirectionalstream-options-options) = {});
  /* a ReadableStream of WebTransportReceiveStream objects */
  readonly attribute [ReadableStream](https://streams.spec.whatwg.org/#readablestream) [incomingUnidirectionalStreams](#dom-webtransport-incomingunidirectionalstreams);
  [WebTransportSendGroup](#webtransportsendgroup) [createSendGroup](#dom-webtransport-createsendgroup)();

  static readonly attribute [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [supportsReliableOnly](#dom-webtransport-supportsreliableonly);
};

enum [WebTransportReliabilityMode](#enumdef-webtransportreliabilitymode) {
  ["pending"](#dom-webtransportreliabilitymode-pending),
  ["reliable-only"](#dom-webtransportreliabilitymode-reliable-only),
  ["supports-unreliable"](#dom-webtransportreliabilitymode-supports-unreliable),
};

dictionary [WebTransportHash](#dictdef-webtransporthash) {
  required [DOMString](https://webidl.spec.whatwg.org/#idl-DOMString) [algorithm](#dom-webtransporthash-algorithm);
  required [BufferSource](https://webidl.spec.whatwg.org/#BufferSource) [value](#dom-webtransporthash-value);
};

dictionary [WebTransportOptions](#dictdef-webtransportoptions) {
  [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [allowPooling](#dom-webtransportoptions-allowpooling) = false;
  [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [requireUnreliable](#dom-webtransportoptions-requireunreliable) = false;
  [sequence](https://webidl.spec.whatwg.org/#idl-sequence)<[WebTransportHash](#dictdef-webtransporthash)> [serverCertificateHashes](#dom-webtransportoptions-servercertificatehashes) = [];
  [WebTransportCongestionControl](#enumdef-webtransportcongestioncontrol) [congestionControl](#dom-webtransportoptions-congestioncontrol) = "default";
  [[EnforceRange](https://webidl.spec.whatwg.org/#EnforceRange)] [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short)? [anticipatedConcurrentIncomingUnidirectionalStreams](#dom-webtransportoptions-anticipatedconcurrentincomingunidirectionalstreams) = null;
  [[EnforceRange](https://webidl.spec.whatwg.org/#EnforceRange)] [unsigned short](https://webidl.spec.whatwg.org/#idl-unsigned-short)? [anticipatedConcurrentIncomingBidirectionalStreams](#dom-webtransportoptions-anticipatedconcurrentincomingbidirectionalstreams) = null;
  [sequence](https://webidl.spec.whatwg.org/#idl-sequence)<[DOMString](https://webidl.spec.whatwg.org/#idl-DOMString)> [protocols](#dom-webtransportoptions-protocols) = [];
  [ReadableStreamType](https://streams.spec.whatwg.org/#enumdef-readablestreamtype) [datagramsReadableType](#dom-webtransportoptions-datagramsreadabletype);
};

enum [WebTransportCongestionControl](#enumdef-webtransportcongestioncontrol) {
  ["default"](#dom-webtransportcongestioncontrol-default),
  ["throughput"](#dom-webtransportcongestioncontrol-throughput),
  ["low-latency"](#dom-webtransportcongestioncontrol-low-latency),
};

dictionary [WebTransportCloseInfo](#dictdef-webtransportcloseinfo) {
  [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long) [closeCode](#dom-webtransportcloseinfo-closecode) = 0;
  [USVString](https://webidl.spec.whatwg.org/#idl-USVString) [reason](#dom-webtransportcloseinfo-reason) = "";
};

dictionary [WebTransportSendOptions](#dictdef-webtransportsendoptions) {
  [WebTransportSendGroup](#webtransportsendgroup)? [sendGroup](#dom-webtransportsendoptions-sendgroup) = null;
  [long long](https://webidl.spec.whatwg.org/#idl-long-long) [sendOrder](#dom-webtransportsendoptions-sendorder) = 0;
};

dictionary [WebTransportSendStreamOptions](#dictdef-webtransportsendstreamoptions) : [WebTransportSendOptions](#dictdef-webtransportsendoptions) {
  [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [waitUntilAvailable](#dom-webtransportsendstreamoptions-waituntilavailable) = false;
};

dictionary [WebTransportConnectionStats](#dictdef-webtransportconnectionstats) {
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesSent](#dom-webtransportconnectionstats-bytessent);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesSentOverhead](#dom-webtransportconnectionstats-bytessentoverhead);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesAcknowledged](#dom-webtransportconnectionstats-bytesacknowledged);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [packetsSent](#dom-webtransportconnectionstats-packetssent);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesLost](#dom-webtransportconnectionstats-byteslost);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [packetsLost](#dom-webtransportconnectionstats-packetslost);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesReceived](#dom-webtransportconnectionstats-bytesreceived);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [packetsReceived](#dom-webtransportconnectionstats-packetsreceived);
  [DOMHighResTimeStamp](https://w3c.github.io/hr-time/#dom-domhighrestimestamp) [smoothedRtt](#dom-webtransportconnectionstats-smoothedrtt);
  [DOMHighResTimeStamp](https://w3c.github.io/hr-time/#dom-domhighrestimestamp) [rttVariation](#dom-webtransportconnectionstats-rttvariation);
  [DOMHighResTimeStamp](https://w3c.github.io/hr-time/#dom-domhighrestimestamp) [minRtt](#dom-webtransportconnectionstats-minrtt);
  required [WebTransportDatagramStats](#dictdef-webtransportdatagramstats) [datagrams](#dom-webtransportconnectionstats-datagrams);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long)? [estimatedSendRate](#dom-webtransportconnectionstats-estimatedsendrate) = null;
  [boolean](https://webidl.spec.whatwg.org/#idl-boolean) [atSendCapacity](#dom-webtransportconnectionstats-atsendcapacity) = false;
};

dictionary [WebTransportDatagramStats](#dictdef-webtransportdatagramstats) {
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [droppedIncoming](#dom-webtransportdatagramstats-droppedincoming);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [expiredIncoming](#dom-webtransportdatagramstats-expiredincoming);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [expiredOutgoing](#dom-webtransportdatagramstats-expiredoutgoing);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [lostOutgoing](#dom-webtransportdatagramstats-lostoutgoing);
};

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext), [Transferable](https://html.spec.whatwg.org/multipage/structured-data.html#transferable)]
interface [WebTransportSendStream](#webtransportsendstream) : [WritableStream](https://streams.spec.whatwg.org/#writablestream) {
  attribute [WebTransportSendGroup](#webtransportsendgroup)? [sendGroup](#dom-webtransportsendstream-sendgroup);
  attribute [long long](https://webidl.spec.whatwg.org/#idl-long-long) [sendOrder](#dom-webtransportsendstream-sendorder);
  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats)> [getStats](#dom-webtransportsendstream-getstats)();
  [WebTransportWriter](#webtransportwriter) [getWriter](#dom-webtransportsendstream-getwriter)();
};

dictionary [WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats) {
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesWritten](#dom-webtransportsendstreamstats-byteswritten);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesSent](#dom-webtransportsendstreamstats-bytessent);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesAcknowledged](#dom-webtransportsendstreamstats-bytesacknowledged);
};

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface [WebTransportSendGroup](#webtransportsendgroup) {
  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportSendStreamStats](#dictdef-webtransportsendstreamstats)> [getStats](#dom-webtransportsendgroup-getstats)();
};

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext), [Transferable](https://html.spec.whatwg.org/multipage/structured-data.html#transferable)]
interface [WebTransportReceiveStream](#webtransportreceivestream) : [ReadableStream](https://streams.spec.whatwg.org/#readablestream) {
  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[WebTransportReceiveStreamStats](#dictdef-webtransportreceivestreamstats)> [getStats](#dom-webtransportreceivestream-getstats)();
};

dictionary [WebTransportReceiveStreamStats](#dictdef-webtransportreceivestreamstats) {
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesReceived](#dom-webtransportreceivestreamstats-bytesreceived);
  [unsigned long long](https://webidl.spec.whatwg.org/#idl-unsigned-long-long) [bytesRead](#dom-webtransportreceivestreamstats-bytesread);
};

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface [WebTransportBidirectionalStream](#webtransportbidirectionalstream) {
  readonly attribute [WebTransportReceiveStream](#webtransportreceivestream) [readable](#dom-webtransportbidirectionalstream-readable);
  readonly attribute [WebTransportSendStream](#webtransportsendstream) [writable](#dom-webtransportbidirectionalstream-writable);
};

[Exposed=*, [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface [WebTransportWriter](#webtransportwriter) : [WritableStreamDefaultWriter](https://streams.spec.whatwg.org/#writablestreamdefaultwriter) {
  [Promise](https://webidl.spec.whatwg.org/#idl-promise)<[undefined](https://webidl.spec.whatwg.org/#idl-undefined)> [atomicWrite](#dom-webtransportwriter-atomicwrite)(optional [any](https://webidl.spec.whatwg.org/#idl-any) [chunk](#dom-webtransportwriter-atomicwrite-chunk-chunk));
  [undefined](https://webidl.spec.whatwg.org/#idl-undefined) [commit](#dom-webtransportwriter-commit)();
};

[[Exposed](https://webidl.spec.whatwg.org/#Exposed)=(Window,Worker), [Serializable](https://html.spec.whatwg.org/multipage/structured-data.html#serializable), [SecureContext](https://webidl.spec.whatwg.org/#SecureContext)]
interface [WebTransportError](#webtransporterror) : [DOMException](https://webidl.spec.whatwg.org/#idl-DOMException) {
  [constructor](#dom-webtransporterror-webtransporterror)(optional [DOMString](https://webidl.spec.whatwg.org/#idl-DOMString) [message](#dom-webtransporterror-webtransporterror-message-options-message) = "", optional [WebTransportErrorOptions](#dictdef-webtransporterroroptions) [options](#dom-webtransporterror-webtransporterror-message-options-options) = {});

  readonly attribute [WebTransportErrorSource](#enumdef-webtransporterrorsource) [source](#dom-webtransporterror-source);
  readonly attribute [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long)? [streamErrorCode](#dom-webtransporterror-streamerrorcode);
};

dictionary [WebTransportErrorOptions](#dictdef-webtransporterroroptions) {
  [WebTransportErrorSource](#enumdef-webtransporterrorsource) [source](#dom-webtransporterroroptions-source) = "stream";
  [[Clamp](https://webidl.spec.whatwg.org/#Clamp)] [unsigned long](https://webidl.spec.whatwg.org/#idl-unsigned-long)? [streamErrorCode](#dom-webtransporterroroptions-streamerrorcode) = null;
};

enum [WebTransportErrorSource](#enumdef-webtransporterrorsource) {
  ["stream"](#dom-webtransporterrorsource-stream),
  ["session"](#dom-webtransporterrorsource-session),
};

## Issues Index[](#issues-index)

 This needs to be done in workers too. See[#127](https://www.github.com/w3c/webtransport/issues/127) and[whatwg/html#6731](https://www.github.com/whatwg/html/issues/6831). [↵](#issue-c18b6608 "Jump to section")

 This configuration option is considered a feature at risk due to the lack of implementation in browsers of a congestion control algorithm, at the time of writing, that optimizes for low latency.

[↵](#issue-398c2337 "Jump to section") 

`[bytesAcknowledged](#dom-webtransportconnectionstats-bytesacknowledged)` on `[WebTransportConnectionStats](#dictdef-webtransportconnectionstats)` has been identified by the Working Group as a feature at risk due to concerns over implementability.[↵](#issue-6431e51e "Jump to section")