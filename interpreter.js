/*
A very simple (abstract/tracing) interpreter that takes in the AST generated by js_astify.js. Inteprets only a fragment of javascript (eg does not deal with objects, loops, etc.
Nothing fancy here.
*/

var escodegen = require('escodegen');
var church_builtins = require('./church_builtins');
var erp = require('./probabilistic/erp.js')
var pr = require('./probabilistic/index.js')
// make erp exports directly avaialable (gnarly use of eval to get in scope):
for (var prop in erp) {
    eval(prop + "= erp."+prop)
}


var Environment = function Environment(baseenv) {
    this.base = baseenv
    this.bindings = {}
    this.depth = (baseenv==undefined)?0:baseenv.depth+1
}

Environment.prototype.bind = function Environment_bind(name, val) {
    this.bindings[name] = val
}

Environment.prototype.lookup = function Environment_lookup(name) {
    val = this.bindings[name]
    if((val == undefined) && this.base) {return this.base.lookup(name)}
    return val
}


//the abstract value class:
function Abstract() {
    this.id = "ab"+nextId()
}

function isAbstract(a) {return a instanceof Abstract}
function isClosure(fn) {return fn.type && (fn.type == 'FunctionExpression')}

var AbstractId = 0
function nextId(){return AbstractId++}

function _randomChoice(erp, params) {
    var ret = new Abstract()
    global_trace.push("var "+valString(ret)+" = random(" + valString(erp) +", "+ valString(params) +");")
    return ret
}

//tmp:
function condition(val) {
    return val
}
function traceMH(val) {
    return "tmp"
}

function valString(ob) {
    if (ob instanceof Array) {
        var ret = "["
        for(var v in ob){
            ret = ret + valString(ob[v])+","
        }
        return ret.concat("]")
    }
    if (isAbstract(ob)){
        return ob.id
    }
    if (typeof ob === "boolean"
        || typeof ob === "number") {
        return ob.toString()
    }
    if (typeof ob === "string") {
        return "'"+ob.toString()+"'"
    }
    //otherwise generate json parsable representation:
    var json = JSON.stringify(ob)
    return "JSON.parse(" + json + ")"
}


var max_trace_depth = 100
global_trace=[]

//an abstract interpreter / tracer.
//a normal interpreter except for certain cases where there is an abstract value. then emit a statement into the trace.
function tracer(ast, env) {
    env = (env==undefined?new Environment():env)
//    console.log(ast)
//    console.log(env)
    var ret
    switch (ast.type) {
            //First the statements:
        case 'Program':
        case 'BlockStatement':
            var ret
            for (a in ast.body) {
                ret = tracer(ast.body[a],env)
            }
            return ret
            
        case 'ExpressionStatement':
            return tracer(ast.expression, env)
            
//comment out because church compile uses ternary op, not if...
//        case 'IfStatement':
//            var test = tracer(ast.test,env)
//            if(test instanceof Abstract) {
//                //FIXME: tracing both sides of if could lead to infinite recursion, but maybe not for cases we care about...
//                var ret = new Abstract()
//                var cons = tracer(ast.consequent,env)
//                cons = (cons instanceof Abstract)? cons.id : cons //FIXME to string?
//                var alt = tracer(ast.alternate, env)
//                alt = (alt instanceof Abstract)? alt.id : alt
//                var tracestring = "var "+ret.id+" = "+test.id+"?"+cons+":"+alt+";"
//                global_trace.push(tracestring)
//
//                return ret
//            }
//            return test?tracer(ast.consequent,env):tracer(ast.alternate, env)
            
        case 'ReturnStatement':
            var val = tracer(ast.argument, env)
            var e ={thrown_return: true, val: val}
            throw e
            
        case 'VariableDeclaration':
            env.bind(ast.declarations[0].id.name, tracer(ast.declarations[0].init,env))
            return undefined
            
            
        //Next the expresisons:
        case 'FunctionExpression':
            //represent a closure as the AST with a pointer t the enclosing env.
            ast.env = env
            return ast
            
        case 'MemberExpression':
            var ob = tracer(ast.object,env)
            if (!ast.computed) {
                return ob[ast.property.name]
            } else {
                throw new Error("Have not implemented computed member reference.")
            }
            
        case 'ArrayExpression':
            var ret = []
            for (a in ast.elements) {
                ret.push(tracer(ast.elements[a],env))
            }
            return ret
            
        case 'CallExpression':
            var args = []
            var abstract_args=false
            for(a in ast.arguments) {
                var val = tracer(ast.arguments[a], env)
                args.push(val)
                if(isAbstract(val) || isClosure(val)) {abstract_args=true}
            }
            var fn = tracer(ast.callee,env)
            
            if(isClosure(fn)) {
                var callenv = new Environment(fn.env)
                for(a in args) {
//                    console.log("binding arg "+fn.params[a].name+" to "+args[a])
                    callenv.bind(fn.params[a].name,args[a])
                }
                try {
                    tracer(fn.body,callenv)
                } catch (e) {
                    if (e.thrown_return) {return e.val}
                    throw e
                }
                return undefined
            }
    
            //if callee isn't a closure and any args are abstract, emit new assignment into trace.
            //if the fn is list or pair, go ahead and do it, even with abstract args to ennable allocation removal. NOTE: could abstracts in lists screw up other things?
            var isadtcons = (fn == church_builtins.list) || (fn == church_builtins.pair)
            if(abstract_args && !isadtcons) {
                var ret = new Abstract()
                var fnstring = escodegen.generate(ast.callee) //FIXME: use json?
                tracestring = "var "+ret.id+" = "+fnstring+"("
                for(a in args){
                    tracestring = tracestring + valString(args[a]) + ","
                }
                global_trace.push(tracestring.slice(0,-1)+");")
                return ret
            }
            //otherwise just do the fn:
            return fn.apply(fn,args)
            
            
        case 'ConditionalExpression':
            var test = tracer(ast.test,env)
            if(isAbstract(test)) {
                //FIXME: tracing both sides of if could lead to infinite recursion, but maybe not for cases we care about...
                var ret = new Abstract()
                if(env.depth==max_trace_depth) {
                    //depth maxed out, don't trace branches, just generate code for this call to trace:
                    global_trace.push("var "+ret.id +" = "+escodegen.generate(ast))
                } else {
                    global_trace.push("if("+valString(test)+") {")
                    var cons = valString(tracer(ast.consequent,env))
                    global_trace.push("var "+ret.id+" = "+cons +";}")
                    global_trace.push(" else {")
                    var alt = valString(tracer(ast.alternate, env))
                    global_trace.push("var "+ret.id+" = "+alt +";}")
//                    var tracestring = "var "+ret.id+" = "+valString(test)+"?"+cons+":"+alt+";"
//                    global_trace.push(tracestring)
                }
                
                return ret
            }
            return test?tracer(ast.consequent,env):tracer(ast.alternate, env)
            
            
        case 'Identifier':
            //lookup in interpreter environment:
            var v = env.lookup(ast.name)
            //if not found, assume it will be defined in js environment for interpreter:
            if(v == undefined){v = eval(ast.name)} //FIXME: better way to do this?
            return v
            
        case 'Literal':
            return ast.value
            
        default:
            throw new Error("Don't know how to handle "+ast.type)
    }
}


//var precompile_queries =
//{
//enter: function(ast) {
//    if(ast.type == 'CallExpression'
//       && ast.callee.type == 'Identifier'
//       && ast.callee.name == 'church_builtins.wrapped_traceMH') {
//        
//        
//        
//        return expanded
//    }
//    return node
//}
//}



module.exports =
{
//    interpret : interpret,
    tracer: tracer,
global_trace: global_trace
}


/* Notes:
 
 -Should generate the trace as an AST to make further transforms easier.
 -Make a query transformer that does the tracing compilation only on the query computation().
 -Do a condition propogation pass?
 
 -One special kind of randomChoice is those guaranteed to exist. Those can get simple static names. Can detect from the interpretation by passing down whether we are in an (abstract) if branch.
 -Another special kind of randomChoice are the non-structural ones.
 -Maybe all randomChoices that are traced through should get simple static ids, then keep a big vector that ins't all used?

 -Within code generated by tracing, don't need enter/leave wrapping. Only right before randomChoice or untraced fall-through.
 
 -Trace through ERP lookup (scoring / sampling)?
 
 -FIXME! need to put traces of parts in conditionals into ifs, otherwise rcs always exist.
 
 -Overall compilation path:
    -Run tokenizer, church_astify, and js_astify to get (core) js.
    -Apply tracer to trace out the computation in any query calls.
        -Propogate conditions as far up as possible.
        -Add notation for guaranteed random choices.
        -Trace out / inline RC lookups?
    -Apply wctransfrom transformer to add addressing (and put in pseudo A-normal form).
        -The wctransform doesn't need to annotate primitive calls with addresses.
 
 -Runtime
    -Guaranteed rcs should have different (fast) lookup path.
    -Non-structural proposals use flat list
 
*/

//function interpret(ast, env) {
//    env = (env==undefined?new Environment():env)
//    var ret
//    switch (ast.type) {
//        //First the statements:
//        case 'Program':
//        case 'BlockStatement':
//            var ret
//            for (a in ast.body) {
//                ret = interpret(ast.body[a],env)
//            }
//            return ret
//
//        case 'ExpressionStatement':
//            return interpret(ast.expression, env)
//
//        case 'IfStatement':
//            var test = interpret(ast.test,env)
//            return test?interpret(ast.consequent,env):interpret(ast.alternate, env)
//
//        case 'ReturnStatement':
//            var val = interpret(ast.argument, env)
//            var e ={thrown_return: true, val: val}
//            throw e
//
//        case 'VariableDeclaration':
//            env.bind(ast.declarations.id.name, inerpret(ast.declarations.init,env))
//            return undefined
//
//
//        //Next the expresisons:
//        case 'FunctionExpression':
//            //represent a closure as the AST extended by an env field, which is a copy of current env.
//            ast.env = new Environment(env)
//            return ast
//
//        case 'MemberExpression':
//            var ob = interpret(ast.object,env)
//            if (!ast.computed) {
//                return ob[ast.property.name]
//            } else {
//                throw new Error("Have not implemented computed member reference.")
//            }
//
//        case 'ArrayExpression':
//            var ret = []
//            for (a in ast.elements) {
//                ret.push(interpret(ast.elements[a],env))
//            }
//            return ret
//
//        case 'CallExpression':
//            var fn = interpret(ast.callee,env)
//            var args = []
//            for(a in ast.arguments) {
//                args.push(interpret(ast.arguments[a], env))
//            }
//            if(fn.type && (fn.type == 'FunctionExpression')) {
//                for(a in args) {
//                    fn.env.bind(fn.params[a].name,args[a])
//                }
//                try {
//                    interpret(fn.body,fn.env)
//                } catch (e) {
//                    if (e.thrown_return) {return e.val}
//                    throw e
//                }
//                return undefined
//            }
////            else {
////              //if callee is provided from erp.js, call it:
////                if(fn in erp) {
////                    erp[fn].apply(null,args)
////                }
////            }
//            //if callee isn't a closure built by interpreter or an erp, assume its a js function already:
//            return fn.apply(fn,args)
//
//
////        case 'ConditionalExpression':
//
//
//        case 'Identifier':
//            //lookup in interpreter environment:
//            var v = env.lookup(ast.name)
//            //if not found, assume it will be defined in js environment for interpreter:
//            if(!v){v = eval(ast.name)} //FIXME: better way to do this?
//            return v
//
//        case 'Literal':
//            return ast.value
//
//        default:
//            throw new Error("Don't know how to handle "+ast.type)
//    }
//}